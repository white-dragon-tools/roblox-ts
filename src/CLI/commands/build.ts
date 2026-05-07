import { CLIError } from "CLI/errors/CLIError";
import fs from "fs-extra";
import path from "path";
import { cleanup } from "Project/functions/cleanup";
import { compileFiles } from "Project/functions/compileFiles";
import { copyFiles } from "Project/functions/copyFiles";
import { copyInclude } from "Project/functions/copyInclude";
import {
	buildWorkspaceWithSolutionBuilder,
	watchWorkspaceWithSolutionBuilder,
} from "Project/functions/buildWorkspaceWithSolutionBuilder";
import { createPathTranslator } from "Project/functions/createPathTranslator";
import { createProjectData } from "Project/functions/createProjectData";
import { createProjectProgram } from "Project/functions/createProjectProgram";
import { getChangedSourceFiles } from "Project/functions/getChangedSourceFiles";
import { setupProjectWatchProgram } from "Project/functions/setupProjectWatchProgram";
import { LogService } from "Shared/classes/LogService";
import { DEFAULT_PROJECT_OPTIONS, ProjectType } from "Shared/constants";
import { LoggableError } from "Shared/errors/LoggableError";
import { ProjectOptions } from "Shared/types";
import { getRootDirs } from "Shared/util/getRootDirs";
import { hasErrors } from "Shared/util/hasErrors";
import ts from "typescript";
import type yargs from "yargs";

function getTsConfigProjectOptions(tsConfigPath?: string): Partial<ProjectOptions> | undefined {
	if (tsConfigPath !== undefined) {
		const rawJson = ts.sys.readFile(tsConfigPath);
		if (rawJson !== undefined) {
			const config = ts.parseConfigFileTextToJson(tsConfigPath, rawJson).config;
			return config.rbxts ?? config.rbxtsc;
		}
	}
}

function findTsConfigPath(projectPath: string) {
	let tsConfigPath: string | undefined = path.resolve(projectPath);
	if (!fs.existsSync(tsConfigPath) || !fs.statSync(tsConfigPath).isFile()) {
		tsConfigPath = ts.findConfigFile(tsConfigPath, ts.sys.fileExists);
		if (tsConfigPath === undefined) {
			throw new CLIError("Unable to find tsconfig.json!");
		}
	}
	return path.resolve(process.cwd(), tsConfigPath);
}

function findWorkspaceConfigPath(projectPath: string) {
	for (let currentPath = path.resolve(projectPath); ; currentPath = path.dirname(currentPath)) {
		const workspaceConfigPath = path.join(currentPath, "pnpm-workspace.yaml");
		if (fs.pathExistsSync(workspaceConfigPath)) {
			return workspaceConfigPath;
		}

		const parentPath = path.dirname(currentPath);
		if (parentPath === currentPath) break;
	}
	throw new CLIError("Unable to find pnpm-workspace.yaml!");
}

function parseWorkspacePackagePatterns(workspaceConfigPath: string) {
	const packagePatterns = new Array<string>();
	const excludePackagePatterns = new Array<string>();
	let inPackages = false;
	for (const line of fs.readFileSync(workspaceConfigPath, "utf8").split(/\r?\n/g)) {
		const trimmedLine = line.trim();
		if (trimmedLine === "packages:") {
			inPackages = true;
			continue;
		}
		if (!inPackages) continue;
		if (trimmedLine.length === 0 || trimmedLine.startsWith("#")) continue;
		if (!trimmedLine.startsWith("-")) break;

		const packagePattern = trimmedLine
			.slice(1)
			.trim()
			.replace(/^['"]|['"]$/g, "");
		if (packagePattern.startsWith("!")) {
			excludePackagePatterns.push(packagePattern.slice(1));
		} else if (packagePattern.length > 0) {
			packagePatterns.push(packagePattern);
		}
	}
	if (packagePatterns.length === 0) {
		throw new CLIError(`No workspace package patterns found in ${workspaceConfigPath}`);
	}
	return { excludePackagePatterns, packagePatterns };
}

function getAllPackagePaths(workspacePath: string) {
	const packagePaths = new Array<string>();

	function visit(currentPath: string) {
		if (fs.pathExistsSync(path.join(currentPath, "package.json"))) {
			packagePaths.push(currentPath);
		}
		if (!fs.pathExistsSync(currentPath)) return;

		for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			if (entry.name === "node_modules" || entry.name === ".git") continue;
			visit(path.join(currentPath, entry.name));
		}
	}

	visit(workspacePath);
	return packagePaths;
}

function patternToRegExp(packagePattern: string) {
	const normalizedPattern = packagePattern.replace(/\\/g, "/");
	let pattern = "^";
	for (let i = 0; i < normalizedPattern.length; i++) {
		const char = normalizedPattern[i];
		if (char === "*") {
			if (normalizedPattern[i + 1] === "*") {
				pattern += ".*";
				i++;
			} else {
				pattern += "[^/]*";
			}
		} else {
			pattern += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
		}
	}
	pattern += "$";
	return new RegExp(pattern);
}

function matchesWorkspacePattern(workspacePath: string, packagePath: string, packagePattern: string) {
	// path.relative(root, root) returns "" but pnpm's "." pattern is meant to match the workspace root.
	const relativePath = path.relative(workspacePath, packagePath).replace(/\\/g, "/") || ".";
	return patternToRegExp(packagePattern).test(relativePath);
}

function getWorkspacePackagePaths(
	workspacePath: string,
	packagePatterns: Array<string>,
	excludePackagePatterns: Array<string>,
) {
	return getAllPackagePaths(workspacePath).filter(packagePath => {
		const included = packagePatterns.some(packagePattern =>
			matchesWorkspacePattern(workspacePath, packagePath, packagePattern),
		);
		if (!included) return false;

		return !excludePackagePatterns.some(packagePattern =>
			matchesWorkspacePattern(workspacePath, packagePath, packagePattern),
		);
	});
}

function isWorkspaceDependency(version: string) {
	return version.startsWith("workspace:") || version.startsWith("link:") || version.startsWith("file:");
}

interface WorkspacePackage {
	name: string;
	path: string;
	tsConfigPath: string;
	dependencies: Array<string>;
}

function getWorkspacePackages(workspaceConfigPath: string) {
	const workspacePath = path.dirname(workspaceConfigPath);
	const { excludePackagePatterns, packagePatterns } = parseWorkspacePackagePatterns(workspaceConfigPath);
	const packagePaths = getWorkspacePackagePaths(workspacePath, packagePatterns, excludePackagePatterns);

	const workspacePackages = new Array<WorkspacePackage>();
	const packageNames = new Set<string>();
	for (const packagePath of packagePaths) {
		const packageJsonPath = path.join(packagePath, "package.json");
		const tsConfigPath = path.join(packagePath, "tsconfig.json");
		if (!fs.pathExistsSync(tsConfigPath)) continue;

		const packageJson = fs.readJsonSync(packageJsonPath) as {
			name?: string;
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
			peerDependencies?: Record<string, string>;
			optionalDependencies?: Record<string, string>;
		};
		if (packageJson.name === undefined) continue;

		packageNames.add(packageJson.name);
		workspacePackages.push({
			name: packageJson.name,
			path: packagePath,
			tsConfigPath,
			dependencies: Object.entries({
				...packageJson.dependencies,
				...packageJson.devDependencies,
				...packageJson.peerDependencies,
				...packageJson.optionalDependencies,
			})
				.filter(([, version]) => isWorkspaceDependency(version))
				.map(([name]) => name),
		});
	}

	for (const workspacePackage of workspacePackages) {
		workspacePackage.dependencies = workspacePackage.dependencies.filter(dependency =>
			packageNames.has(dependency),
		);
	}

	return workspacePackages;
}

function orderWorkspacePackages(workspacePackages: Array<WorkspacePackage>) {
	const orderedPackages = new Array<WorkspacePackage>();
	const packageByName = new Map(workspacePackages.map(workspacePackage => [workspacePackage.name, workspacePackage]));
	const permanentMarks = new Set<string>();
	const temporaryMarks = new Set<string>();

	function visit(workspacePackage: WorkspacePackage) {
		if (permanentMarks.has(workspacePackage.name)) return;
		if (temporaryMarks.has(workspacePackage.name)) {
			throw new CLIError(`Circular workspace dependency detected at ${workspacePackage.name}`);
		}

		temporaryMarks.add(workspacePackage.name);
		for (const dependencyName of workspacePackage.dependencies) {
			const dependencyPackage = packageByName.get(dependencyName);
			if (dependencyPackage) visit(dependencyPackage);
		}
		temporaryMarks.delete(workspacePackage.name);
		permanentMarks.add(workspacePackage.name);
		orderedPackages.push(workspacePackage);
	}

	for (const workspacePackage of workspacePackages) {
		visit(workspacePackage);
	}

	return orderedPackages;
}

function createProjectOptions(tsConfigPath: string, argv: BuildFlags & Partial<ProjectOptions>) {
	const argvOptions = Object.fromEntries(Object.entries(argv).filter(([, value]) => value !== undefined));
	return Object.assign({}, DEFAULT_PROJECT_OPTIONS, getTsConfigProjectOptions(tsConfigPath), argvOptions);
}

function buildProject(
	tsConfigPath: string,
	projectOptions: ProjectOptions,
	diagnosticReporter: ts.DiagnosticReporter,
	cwd = process.cwd(),
) {
	const originalCwd = process.cwd();
	try {
		process.chdir(cwd);
		const data = createProjectData(tsConfigPath, projectOptions);
		const program = createProjectProgram(data);
		const pathTranslator = createPathTranslator(program, data);
		cleanup(pathTranslator);
		copyInclude(data);
		copyFiles(data, pathTranslator, new Set(getRootDirs(program.getCompilerOptions())));
		const emitResult = compileFiles(program.getProgram(), data, pathTranslator, getChangedSourceFiles(program));
		for (const diagnostic of emitResult.diagnostics) {
			diagnosticReporter(diagnostic);
		}
		return !hasErrors(emitResult.diagnostics);
	} finally {
		process.chdir(originalCwd);
	}
}

interface BuildFlags {
	project: string;
	workspace?: boolean;
}

/**
 * Defines the behavior for the `rbxtsc build` command.
 */
export = ts.identity<yargs.CommandModule<object, BuildFlags & Partial<ProjectOptions>>>({
	command: ["$0", "build"],

	describe: "Build a project",

	builder: (parser: yargs.Argv) =>
		parser
			.option("project", {
				alias: "p",
				string: true,
				default: ".",
				describe: "project path",
			})
			.option("workspace", {
				boolean: true,
				describe: "build all projects in a pnpm workspace using SolutionBuilder",
			})
			// DO NOT PROVIDE DEFAULTS BELOW HERE, USE DEFAULT_PROJECT_OPTIONS
			.option("watch", {
				alias: "w",
				boolean: true,
				describe: "enable watch mode",
			})
			.option("usePolling", {
				implies: "watch",
				boolean: true,
				describe: "use polling for watch mode",
			})
			.option("verbose", {
				boolean: true,
				describe: "enable verbose logs",
			})
			.option("noInclude", {
				boolean: true,
				describe: "do not copy include files",
			})
			.option("logTruthyChanges", {
				boolean: true,
				describe: "logs changes to truthiness evaluation from Lua truthiness rules",
			})
			.option("writeOnlyChanged", {
				boolean: true,
				hidden: true,
			})
			.option("writeTransformedFiles", {
				boolean: true,
				hidden: true,
				describe: "writes resulting TypeScript ASTs after transformers to out directory",
			})
			.option("optimizedLoops", {
				boolean: true,
				hidden: true,
			})
			.option("type", {
				choices: [ProjectType.Game, ProjectType.Model, ProjectType.Package] as const,
				describe: "override project type",
			})
			.option("includePath", {
				alias: "i",
				string: true,
				describe: "folder to copy runtime files to",
			})
			.option("rojo", {
				string: true,
				describe: "manually select Rojo project file",
			})
			.option("allowCommentDirectives", {
				boolean: true,
				hidden: true,
			})
			.option("luau", {
				boolean: true,
				describe: "emit files with .luau extension",
			}),

	handler: async argv => {
		try {
			const projectPath = path.resolve(argv.project);

			LogService.verbose = argv.verbose === true;

			const diagnosticReporter = ts.createDiagnosticReporter(ts.sys, true);

			if (argv.workspace) {
				const workspaceConfigPath = findWorkspaceConfigPath(projectPath);
				const workspacePackages = orderWorkspacePackages(getWorkspacePackages(workspaceConfigPath));

				if (workspacePackages.length === 0) {
					throw new CLIError(
						`No workspace packages discovered from ${path.relative(process.cwd(), workspaceConfigPath)}. ` +
							`Each candidate must have a tsconfig.json and a package.json with a "name" field.`,
					);
				}

				const tsConfigByName = new Map(
					workspacePackages.map(workspacePackage => [
						workspacePackage.name,
						workspacePackage.tsConfigPath,
					]),
				);
				const members = workspacePackages.map(workspacePackage => ({
					name: workspacePackage.name,
					tsConfigPath: workspacePackage.tsConfigPath,
					dependencyTsConfigPaths: workspacePackage.dependencies
						.map(depName => tsConfigByName.get(depName))
						.filter((value): value is string => value !== undefined),
				}));
				if (argv.watch) {
					watchWorkspaceWithSolutionBuilder(members, argv, diagnosticReporter);
				} else if (!buildWorkspaceWithSolutionBuilder(members, argv, diagnosticReporter)) {
					process.exitCode = 1;
				}
			} else {
				const tsConfigPath = findTsConfigPath(projectPath);
				const projectOptions = createProjectOptions(tsConfigPath, argv);
				LogService.verbose = projectOptions.verbose === true;
				const data = createProjectData(tsConfigPath, projectOptions);
				if (projectOptions.watch) {
					setupProjectWatchProgram(data, projectOptions.usePolling);
				} else {
					if (!buildProject(tsConfigPath, projectOptions, diagnosticReporter)) {
						process.exitCode = 1;
					}
				}
			}
		} catch (e) {
			process.exitCode = 1;
			if (e instanceof LoggableError) {
				e.log();
				debugger;
			} else {
				throw e;
			}
		}
	},
});
