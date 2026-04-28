import fs from "fs";
import kleur from "kleur";
import path from "path";
import { DTS_EXT, NODE_MODULES, RBXTS_SCOPE } from "Shared/constants";
import { ProjectError } from "Shared/errors/ProjectError";
import ts from "typescript";

const ENFORCED_OPTIONS = {
	target: ts.ScriptTarget.ESNext,
	module: ts.ModuleKind.CommonJS,
	moduleDetection: ts.ModuleDetectionKind.Force,
	moduleResolution: ts.ModuleResolutionKind.Node10,
	noLib: true,
	strict: true,
	allowSyntheticDefaultImports: true,
} as const;

/** shorthand for kleur.yellow */
function y(str: string) {
	return kleur.yellow(str);
}

function addUniquePath(paths: Array<string>, fsPath: string) {
	const normalizedPath = path.normalize(fsPath);
	if (!paths.some(v => path.normalize(v) === normalizedPath)) {
		paths.push(normalizedPath);
	}
}

function validateTypeRoots(nodeModulesPaths: Array<string>, typeRoots: Array<string>) {
	const typesPaths = nodeModulesPaths.map(nodeModulesPath => path.resolve(nodeModulesPath, RBXTS_SCOPE));
	for (const typeRoot of typeRoots) {
		if (typesPaths.some(typesPath => path.resolve(typeRoot) === typesPath)) {
			return true;
		}
	}
	return false;
}

function expandTypeRoots(opts: ts.CompilerOptions, projectPath: string, nodeModulesPaths: Array<string>) {
	const expandedTypeRoots = new Array<string>();
	for (const typeRoot of opts.typeRoots ?? []) {
		const resolvedTypeRoot = path.resolve(projectPath, typeRoot);
		addUniquePath(expandedTypeRoots, resolvedTypeRoot);

		const relativeToProjectNodeModules = path.relative(nodeModulesPaths[0], resolvedTypeRoot);
		if (!relativeToProjectNodeModules.startsWith("..") && relativeToProjectNodeModules !== "") {
			for (const nodeModulesPath of nodeModulesPaths.slice(1)) {
				const candidateTypeRoot = path.join(nodeModulesPath, relativeToProjectNodeModules);
				if (fs.existsSync(candidateTypeRoot)) {
					addUniquePath(expandedTypeRoots, candidateTypeRoot);
				}
			}
		}
	}

	if (expandedTypeRoots.length === 0) {
		for (const nodeModulesPath of nodeModulesPaths) {
			const rbxtsScopePath = path.join(nodeModulesPath, RBXTS_SCOPE);
			if (fs.existsSync(rbxtsScopePath)) {
				addUniquePath(expandedTypeRoots, rbxtsScopePath);
				break;
			}
		}
	}

	opts.typeRoots = expandedTypeRoots;
	return expandedTypeRoots;
}

export function validateCompilerOptions(
	opts: ts.CompilerOptions,
	projectPath: string,
	nodeModulesPaths = [path.join(projectPath, NODE_MODULES)],
) {
	const errors = new Array<string>();

	// required compiler options
	if (opts.noLib !== ENFORCED_OPTIONS.noLib) {
		errors.push(`${y(`"noLib"`)} must be ${y(`true`)}`);
	}

	if (opts.strict !== ENFORCED_OPTIONS.strict) {
		errors.push(`${y(`"strict"`)} must be ${y(`true`)}`);
	}

	if (opts.target !== ENFORCED_OPTIONS.target) {
		// errors.push(`${y(`"target"`)} must be ${y(`"ESNext"`)}`);
	}

	if (opts.module !== ENFORCED_OPTIONS.module) {
		errors.push(`${y(`"module"`)} must be ${y(`commonjs`)}`);
	}

	if (opts.moduleDetection !== ENFORCED_OPTIONS.moduleDetection) {
		errors.push(`${y(`"moduleDetection"`)} must be ${y(`"force"`)}`);
	}

	if (opts.moduleResolution !== ENFORCED_OPTIONS.moduleResolution) {
		errors.push(`${y(`"moduleResolution"`)} must be ${y(`"Node"`)}`);
	}

	if (opts.allowSyntheticDefaultImports !== ENFORCED_OPTIONS.allowSyntheticDefaultImports) {
		errors.push(`${y(`"allowSyntheticDefaultImports"`)} must be ${y(`true`)}`);
	}

	const typeRoots = expandTypeRoots(opts, projectPath, nodeModulesPaths);
	const rbxtsModules = nodeModulesPaths.map(nodeModulesPath => path.join(nodeModulesPath, RBXTS_SCOPE));
	if (!validateTypeRoots(nodeModulesPaths, typeRoots)) {
		errors.push(`${y(`"typeRoots"`)} must contain one of: ${rbxtsModules.map(y).join(", ")}`);
	}

	for (const typesLocation of opts.types ?? []) {
		// Technically checked to exist above
		// But if that's an error, we still want this error too,
		// To avoid "fix one error, get a new one on the next compile"
		if (
			!typeRoots.some(typeRoot => {
				const typesPath = path.resolve(projectPath, typeRoot, typesLocation);
				return fs.existsSync(typesPath) || fs.existsSync(typesPath + DTS_EXT);
			})
		) {
			errors.push(
				`${y(`"types"`)} ${y(typesLocation)} were not found. Make sure the path is relative to \`typeRoots\``,
			);
		}
	}

	// configurable compiler options
	if (opts.rootDir === undefined && opts.rootDirs === undefined) {
		errors.push(`${y(`"rootDir"`)} or ${y(`"rootDirs"`)} must be defined`);
	}

	if (opts.outDir === undefined) {
		errors.push(`${y(`"outDir"`)} must be defined`);
	}

	// eslint-disable-next-line @typescript-eslint/no-deprecated -- code specifically warns about using the deprecated item
	if (opts.importsNotUsedAsValues !== undefined) {
		// eslint-disable-next-line @typescript-eslint/no-deprecated -- see above
		const suggestedValue = opts.importsNotUsedAsValues === ts.ImportsNotUsedAsValues.Preserve ? "true" : "false";
		errors.push(
			`${y(`"importsNotUsedAsValues"`)} is no longer supported, use ${y(`"verbatimModuleSyntax": ${suggestedValue}`)} instead`,
		);
	}

	// throw if errors
	if (errors.length > 0) {
		throw new ProjectError(
			[
				`Invalid "tsconfig.json" configuration!`,
				`https://roblox-ts.com/docs/quick-start#project-folder-setup`,
				errors.map(e => `- ${e}\n`).join(""),
			].join("\n"),
		);
	}
}
