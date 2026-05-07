// Experimental workspace driver backed by ts.createSolutionBuilder.
// Hidden behind --useSolutionBuilder. The non-experimental code path remains
// the in-tree pnpm-workspace parser + topo + manifest in src/CLI/commands/build.ts.
//
// Experimental workspace driver backed by ts.createSolutionBuilder.
// Hidden behind --useSolutionBuilder. The non-experimental code path remains
// the in-tree pnpm-workspace parser + topo + manifest in src/CLI/commands/build.ts.
//
// Open spike items (intentionally not addressed yet):
// - Flamework cross-package macro: the seedFlameworkBuildInfoCandidates path in
//   createTransformerList runs during the inner program's emit, but workspaceBuildArtifacts
//   is not yet plumbed through this driver.
// - User ergonomics: requires composite/references/skipLibCheck per-package; could be
//   auto-injected from getWorkspacePackages in a future iteration.
// - Double .d.ts emit: TS's pre-hook emit writes .d.ts; compileFiles re-emits via
//   transformPaths/transformTypeReferenceDirectives. Wasteful but correct.

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
import { DEFAULT_PROJECT_OPTIONS } from "Shared/constants";
import { ProjectOptions } from "Shared/types";
import { getNodeModulesPaths } from "Shared/util/getNodeModulesPaths";
import { getRootDirs } from "Shared/util/getRootDirs";
import ts from "typescript";

function readTsConfigProjectOptions(tsConfigPath: string): Partial<ProjectOptions> | undefined {
	const rawJson = ts.sys.readFile(tsConfigPath);
	if (rawJson === undefined) return undefined;
	const config = ts.parseConfigFileTextToJson(tsConfigPath, rawJson).config;
	return config?.rbxts ?? config?.rbxtsc;
}

export function buildWorkspaceWithSolutionBuilder(
	projectTsConfigPaths: Array<string>,
	cliOptions: Partial<ProjectOptions>,
	diagnosticReporter: ts.DiagnosticReporter,
): boolean {
	const cliOptionEntries = Object.entries(cliOptions).filter(([, value]) => value !== undefined);

	// Captured before TS's emit consumes BuilderProgram.changedFilesSet, so afterProgramEmitAndDiagnostics
	// can drive incremental Luau emit through getChangedSourceFiles(program, pathHints).
	const changedHintsByProgram = new WeakMap<ts.BuilderProgram, Array<string>>();

	const createProgram: ts.CreateProgram<ts.EmitAndSemanticDiagnosticsBuilderProgram> = (
		rootNames,
		options,
		host,
		oldProgram,
		configFileParsingDiagnostics,
		projectReferences,
	) => {
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

	const host = ts.createSolutionBuilderHost(
		ts.sys,
		createProgram,
		diagnosticReporter,
		ts.createBuilderStatusReporter(ts.sys, true),
	);

	const originalWriteFile = host.writeFile!;
	host.writeFile = (fileName: string, contents: string, writeBOM?: boolean) => {
		if (fileName.endsWith(".js") || fileName.endsWith(".js.map")) return;
		originalWriteFile(fileName, contents, writeBOM);
	};

	host.getParsedCommandLine = fileName => {
		const parsed = ts.getParsedCommandLineOfConfigFile(fileName, undefined, {
			fileExists: ts.sys.fileExists,
			getCurrentDirectory: ts.sys.getCurrentDirectory,
			onUnRecoverableConfigFileDiagnostic: diagnostic => diagnosticReporter(diagnostic),
			readDirectory: ts.sys.readDirectory,
			readFile: ts.sys.readFile,
			useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
		});
		if (parsed === undefined) return undefined;
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

	const builder = ts.createSolutionBuilder(host, projectTsConfigPaths, {
		verbose: cliOptions.verbose === true,
	});
	const exitStatus = builder.build();
	return success && exitStatus === ts.ExitStatus.Success;
}
