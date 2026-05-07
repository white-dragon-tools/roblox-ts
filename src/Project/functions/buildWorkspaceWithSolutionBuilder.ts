// Workspace driver backed by ts.createSolutionBuilder.
//
// SolutionBuilder's TS emit writes declarations before roblox-ts transforms run.
// compileFiles intentionally re-emits declarations with afterDeclarations so
// transformPaths and transformTypeReferenceDirectives produce the final .d.ts
// files with roblox-ts path and type-reference rewrites intact.

import chokidar from "chokidar";
import fs from "fs-extra";
import path from "path";
import { cleanup } from "Project/functions/cleanup";
import { compileFiles } from "Project/functions/compileFiles";
import { copyFiles } from "Project/functions/copyFiles";
import { copyInclude } from "Project/functions/copyInclude";
import { createPathTranslator } from "Project/functions/createPathTranslator";
import { createProjectData } from "Project/functions/createProjectData";
import { getChangedSourceFiles } from "Project/functions/getChangedSourceFiles";
import { validateCompilerOptions } from "Project/functions/validateCompilerOptions";
import { isPathDescendantOf } from "Shared/util/isPathDescendantOf";
import { LogService } from "Shared/classes/LogService";
import { DEFAULT_PROJECT_OPTIONS, WORKSPACE_BUILD_ARTIFACTS } from "Shared/constants";
import { ProjectOptions } from "Shared/types";
import { getNodeModulesPaths } from "Shared/util/getNodeModulesPaths";
import { getRootDirs } from "Shared/util/getRootDirs";
import ts from "typescript";

function resolveProjectReferencePath(refRawPath: string, fromConfigPath: string): string {
	const absolute = path.resolve(path.dirname(fromConfigPath), refRawPath);
	if (fs.pathExistsSync(absolute) && fs.statSync(absolute).isDirectory()) {
		return path.join(absolute, "tsconfig.json");
	}
	return absolute;
}

/**
 * Minimum data the driver needs about each workspace package. Derived from getWorkspacePackages
 * in build.ts; passed in so this driver does not re-parse pnpm-workspace.yaml.
 */
export interface WorkspaceMember {
	name: string;
	tsConfigPath: string;
	/** tsconfig paths of *workspace* packages this one depends on (transitive resolution left to TS). */
	dependencyTsConfigPaths: Array<string>;
}

function collectWorkspaceBuildArtifacts(
	tsConfigPath: string,
	parseConfig: (configPath: string) => ts.ParsedCommandLine | undefined,
): Array<string> {
	const artifacts = new Array<string>();
	const visited = new Set<string>();

	const visit = (configPath: string) => {
		if (visited.has(configPath)) return;
		visited.add(configPath);

		const parsed = parseConfig(configPath);
		if (parsed === undefined) return;

		for (const ref of parsed.projectReferences ?? []) {
			visit(resolveProjectReferencePath(ref.path, configPath));
		}

		const packagePath = path.dirname(configPath);
		for (const artifactName of WORKSPACE_BUILD_ARTIFACTS) {
			const artifactPath = path.join(packagePath, artifactName);
			if (fs.pathExistsSync(artifactPath)) {
				artifacts.push(artifactPath);
			}
		}
	};

	const rootParsed = parseConfig(tsConfigPath);
	for (const ref of rootParsed?.projectReferences ?? []) {
		visit(resolveProjectReferencePath(ref.path, tsConfigPath));
	}
	return artifacts;
}

function readTsConfigProjectOptions(tsConfigPath: string): Partial<ProjectOptions> | undefined {
	const rawJson = ts.sys.readFile(tsConfigPath);
	if (rawJson === undefined) return undefined;
	const config = ts.parseConfigFileTextToJson(tsConfigPath, rawJson).config;
	return config?.rbxts ?? config?.rbxtsc;
}

/**
 * Hooks shared by both --useSolutionBuilder and --useSolutionBuilder --watch.
 * Mutates `host` in place. Returns a getter so the caller can read `success` after build.
 */
function configureSolutionBuilderHost(
	host: ts.SolutionBuilderHostBase<ts.EmitAndSemanticDiagnosticsBuilderProgram>,
	workspaceMembers: Array<WorkspaceMember>,
	cliOptions: Partial<ProjectOptions>,
	diagnosticReporter: ts.DiagnosticReporter,
	changedHintsByProgram: WeakMap<ts.BuilderProgram, Array<string>>,
): { isSuccessful: () => boolean } {
	const cliOptionEntries = Object.entries(cliOptions).filter(([, value]) => value !== undefined);

	const memberByConfigPath = new Map<string, WorkspaceMember>();
	for (const member of workspaceMembers) {
		memberByConfigPath.set(path.normalize(member.tsConfigPath), member);
	}

	// composite is required for tsconfigs that ARE referenced by other workspace members; injecting
	// it on consumers (or single-package workspaces with no internal refs) is unnecessary and triggers
	// composite-mode strictness like TS6307 on JSON imports the user never opted in to.
	const referencedConfigPaths = new Set<string>();
	for (const member of workspaceMembers) {
		for (const depConfigPath of member.dependencyTsConfigPaths) {
			referencedConfigPaths.add(path.normalize(depConfigPath));
		}
	}

	// Cached entries are keyed by mtime so a tsconfig edit during watch invalidates the cache
	// (and the auto-inject mutations applied to it) and forces a fresh parse on the next lookup.
	interface CachedParsedCommandLine {
		mtimeMs: number | undefined;
		parsed: ts.ParsedCommandLine | undefined;
	}
	const parsedCommandLineCache = new Map<string, CachedParsedCommandLine>();
	const parseConfig = (configPath: string): ts.ParsedCommandLine | undefined => {
		const mtime = ts.sys.getModifiedTime?.(configPath);
		const mtimeMs = mtime ? mtime.getTime() : undefined;
		const cached = parsedCommandLineCache.get(configPath);
		if (cached !== undefined && cached.mtimeMs === mtimeMs) {
			return cached.parsed;
		}
		const parsed = ts.getParsedCommandLineOfConfigFile(configPath, undefined, {
			fileExists: ts.sys.fileExists,
			getCurrentDirectory: ts.sys.getCurrentDirectory,
			onUnRecoverableConfigFileDiagnostic: diagnostic => diagnosticReporter(diagnostic),
			readDirectory: ts.sys.readDirectory,
			readFile: ts.sys.readFile,
			useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
		});
		parsedCommandLineCache.set(configPath, { mtimeMs, parsed });
		return parsed;
	};

	const originalWriteFile = host.writeFile!;
	host.writeFile = (fileName: string, contents: string, writeBOM?: boolean) => {
		if (fileName.endsWith(".js") || fileName.endsWith(".js.map")) return;
		originalWriteFile(fileName, contents, writeBOM);
	};

	host.getParsedCommandLine = fileName => {
		const parsed = parseConfig(fileName);
		if (parsed === undefined) return undefined;

		const normalizedConfigPath = path.normalize(fileName);
		const member = memberByConfigPath.get(normalizedConfigPath);
		if (member !== undefined) {
			if (referencedConfigPaths.has(normalizedConfigPath)) {
				parsed.options.composite = true;
				parsed.options.declaration = true;
			}
			if (parsed.options.skipLibCheck === undefined) {
				parsed.options.skipLibCheck = true;
			}

			const existingRefs = parsed.projectReferences ?? [];
			const projectDir = path.dirname(fileName);
			const existingRefDirs = new Set(
				existingRefs.map(ref => path.normalize(path.resolve(projectDir, ref.path))),
			);
			const inferredRefs = member.dependencyTsConfigPaths
				.map(depConfigPath => path.dirname(depConfigPath))
				.filter(depDir => !existingRefDirs.has(path.normalize(depDir)))
				.map(depDir => ({ path: depDir }) as ts.ProjectReference);
			if (inferredRefs.length > 0) {
				parsed.projectReferences = [...existingRefs, ...inferredRefs];
			}
		}

		const projectPath = path.dirname(fileName);
		validateCompilerOptions(parsed.options, projectPath, getNodeModulesPaths(projectPath));
		return parsed;
	};

	let success = true;

	host.afterProgramEmitAndDiagnostics = builderProgram => {
		const program = builderProgram.getProgram();
		const compilerOptions = program.getCompilerOptions();
		const tsConfigPath = compilerOptions.configFilePath as string | undefined;
		if (tsConfigPath === undefined) return;

		LogService.writeLineIfVerbose(`Building ${path.relative(process.cwd(), tsConfigPath)}`);

		const projectOptions = Object.assign(
			{},
			DEFAULT_PROJECT_OPTIONS,
			readTsConfigProjectOptions(tsConfigPath),
			Object.fromEntries(cliOptionEntries),
		) as ProjectOptions;
		projectOptions.workspaceBuildArtifacts = collectWorkspaceBuildArtifacts(tsConfigPath, parseConfig);

		const data = createProjectData(tsConfigPath, projectOptions);
		const pathTranslator = createPathTranslator(builderProgram, data);
		cleanup(pathTranslator);
		copyInclude(data);
		const rootDirs = getRootDirs(compilerOptions);
		copyFiles(data, pathTranslator, new Set(rootDirs));

		const hints = changedHintsByProgram.get(builderProgram);
		const sourceFiles = (
			hints !== undefined
				? getChangedSourceFiles(builderProgram, hints)
				: program.getSourceFiles().filter(sourceFile => !sourceFile.isDeclarationFile)
		).filter(sourceFile => rootDirs.some(rootDir => isPathDescendantOf(sourceFile.fileName, rootDir)));
		const emitResult = compileFiles(program, data, pathTranslator, sourceFiles);

		for (const diagnostic of emitResult.diagnostics) {
			diagnosticReporter(diagnostic);
		}
		if (emitResult.diagnostics.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)) {
			success = false;
		}
	};

	return { isSuccessful: () => success };
}

function createSnapshottingProgramFactory(
	changedHintsByProgram: WeakMap<ts.BuilderProgram, Array<string>>,
): ts.CreateProgram<ts.EmitAndSemanticDiagnosticsBuilderProgram> {
	return (rootNames, options, host, oldProgram, configFileParsingDiagnostics, projectReferences) => {
		const builderProgram = ts.createEmitAndSemanticDiagnosticsBuilderProgram(
			rootNames,
			options,
			host,
			oldProgram,
			configFileParsingDiagnostics,
			projectReferences,
		);
		const hints = new Array<string>();
		(builderProgram.getState() as { changedFilesSet?: ReadonlyMap<string, true> }).changedFilesSet?.forEach(
			(_, fileName) => hints.push(fileName),
		);
		changedHintsByProgram.set(builderProgram, hints);
		return builderProgram;
	};
}

export function buildWorkspaceWithSolutionBuilder(
	workspaceMembers: Array<WorkspaceMember>,
	cliOptions: Partial<ProjectOptions>,
	diagnosticReporter: ts.DiagnosticReporter,
): boolean {
	const changedHintsByProgram = new WeakMap<ts.BuilderProgram, Array<string>>();
	const host = ts.createSolutionBuilderHost(
		ts.sys,
		createSnapshottingProgramFactory(changedHintsByProgram),
		diagnosticReporter,
		ts.createBuilderStatusReporter(ts.sys, true),
	);
	const { isSuccessful } = configureSolutionBuilderHost(
		host,
		workspaceMembers,
		cliOptions,
		diagnosticReporter,
		changedHintsByProgram,
	);
	const builder = ts.createSolutionBuilder(
		host,
		workspaceMembers.map(member => member.tsConfigPath),
		{ verbose: cliOptions.verbose === true },
	);
	const exitStatus = builder.build();
	return isSuccessful() && exitStatus === ts.ExitStatus.Success;
}

export function watchWorkspaceWithSolutionBuilder(
	workspaceMembers: Array<WorkspaceMember>,
	cliOptions: Partial<ProjectOptions>,
	diagnosticReporter: ts.DiagnosticReporter,
): void {
	const changedHintsByProgram = new WeakMap<ts.BuilderProgram, Array<string>>();
	const host = ts.createSolutionBuilderWithWatchHost(
		ts.sys,
		createSnapshottingProgramFactory(changedHintsByProgram),
		diagnosticReporter,
		ts.createBuilderStatusReporter(ts.sys, true),
		ts.createWatchStatusReporter(ts.sys, true),
	);
	configureSolutionBuilderHost(host, workspaceMembers, cliOptions, diagnosticReporter, changedHintsByProgram);
	const builder = ts.createSolutionBuilderWithWatch(
		host,
		workspaceMembers.map(member => member.tsConfigPath),
		{ verbose: cliOptions.verbose === true, watch: true },
	);
	builder.build();

	// TS's own watcher tracks .ts/.d.ts/tsconfig.json but not package.json. Mirror the legacy driver
	// by watching each member's package.json and bumping tsconfig.json's mtime on change so the
	// existing TS watcher invalidates and rebuilds the affected project. Workspace dependency-graph
	// changes (added/removed deps) still require a watch restart — same constraint as the legacy path.
	const packageJsonByMember = workspaceMembers.map(member => ({
		packageJsonPath: path.join(path.dirname(member.tsConfigPath), "package.json"),
		tsConfigPath: member.tsConfigPath,
	}));
	const packageJsonPaths = packageJsonByMember
		.map(entry => entry.packageJsonPath)
		.filter(packageJsonPath => fs.pathExistsSync(packageJsonPath));
	if (packageJsonPaths.length > 0) {
		chokidar
			.watch(packageJsonPaths, {
				awaitWriteFinish: { pollInterval: 10, stabilityThreshold: 50 },
				ignoreInitial: true,
				usePolling: cliOptions.usePolling,
			})
			.on("change", changedPath => {
				const entry = packageJsonByMember.find(
					member => path.normalize(member.packageJsonPath) === path.normalize(changedPath),
				);
				if (entry === undefined) return;
				const now = new Date();
				try {
					fs.utimesSync(entry.tsConfigPath, now, now);
				} catch {
					// Best-effort: if touch fails, the user can still trigger a rebuild manually.
				}
			});
	}
}
