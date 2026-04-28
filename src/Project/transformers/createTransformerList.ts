import fs from "fs-extra";
import path from "path";
import resolve from "resolve";
import { warnings } from "Shared/diagnostics";
import { TransformerPluginConfig } from "Shared/types";
import { DiagnosticService } from "TSTransformer/classes/DiagnosticService";
import ts from "typescript";

interface TransformerBasePlugin {
	before?: ts.TransformerFactory<ts.SourceFile>;
	after?: ts.TransformerFactory<ts.SourceFile>;
	afterDeclarations?: ts.TransformerFactory<ts.SourceFile | ts.Bundle>;
}

type TransformerPlugin = TransformerBasePlugin | ts.TransformerFactory<ts.SourceFile>;

type LSPattern = (ls: ts.LanguageService, config: unknown) => TransformerPlugin;

type ProgramPattern = (program: ts.Program, config: unknown, helpers?: { ts: typeof ts }) => TransformerPlugin;

type CompilerOptionsPattern = (compilerOpts: ts.CompilerOptions, config: unknown) => TransformerPlugin;

type ConfigPattern = (config: unknown) => TransformerPlugin;

type TypeCheckerPattern = (checker: ts.TypeChecker, config: unknown) => TransformerPlugin;

type RawPattern = (
	context: ts.TransformationContext,
	program: ts.Program,
	config: unknown,
) => ts.Transformer<ts.SourceFile>;

type PluginFactory =
	| LSPattern
	| ProgramPattern
	| ConfigPattern
	| CompilerOptionsPattern
	| TypeCheckerPattern
	| RawPattern;

interface FlameworkBuildInfoCacheEntry {
	buildInfo: unknown;
	mtimeMs: number;
	size: number;
}

const flameworkBuildInfoCache = new Map<string, FlameworkBuildInfoCacheEntry>();
const flameworkWorkspaceArtifactPathsByPackageRoot = new Map<string, Set<string>>();
const patchedFlameworkPackageRoots = new Set<string>();

function findPackageRoot(modulePath: string) {
	let currentPath = path.dirname(modulePath);
	while (currentPath !== path.dirname(currentPath)) {
		if (ts.sys.fileExists(path.join(currentPath, "package.json"))) {
			return currentPath;
		}
		currentPath = path.dirname(currentPath);
	}
}

function patchFlameworkBuildInfoCache(packageRoot: string, workspaceBuildArtifacts: Array<string>) {
	if (workspaceBuildArtifacts.length === 0) return;

	const workspaceArtifactPaths = new Set(
		workspaceBuildArtifacts
			.filter(
				artifactPath => path.basename(artifactPath) === "flamework.build" && fs.pathExistsSync(artifactPath),
			)
			.map(artifactPath => fs.realpathSync(artifactPath)),
	);
	if (workspaceArtifactPaths.size === 0) return;
	flameworkWorkspaceArtifactPathsByPackageRoot.set(packageRoot, workspaceArtifactPaths);
	if (patchedFlameworkPackageRoots.has(packageRoot)) return;

	// eslint-disable-next-line @typescript-eslint/no-require-imports -- patch Flamework's package-local BuildInfo reader
	const { BuildInfo } = require(path.join(packageRoot, "out/classes/buildInfo.js")) as {
		BuildInfo: {
			fromPath(fileName: string): unknown;
		};
	};

	const originalFromPath = BuildInfo.fromPath.bind(BuildInfo);
	BuildInfo.fromPath = (fileName: string) => {
		if (!fs.pathExistsSync(fileName)) {
			return originalFromPath(fileName);
		}

		const realPath = fs.realpathSync(fileName);
		if (!flameworkWorkspaceArtifactPathsByPackageRoot.get(packageRoot)?.has(realPath)) {
			return originalFromPath(fileName);
		}

		const stat = fs.statSync(realPath);
		const cacheEntry = flameworkBuildInfoCache.get(realPath);
		if (cacheEntry && cacheEntry.mtimeMs === stat.mtimeMs && cacheEntry.size === stat.size) {
			return cacheEntry.buildInfo;
		}

		const buildInfo = originalFromPath(fileName);
		flameworkBuildInfoCache.set(realPath, {
			buildInfo,
			mtimeMs: stat.mtimeMs,
			size: stat.size,
		});
		return buildInfo;
	};
	patchedFlameworkPackageRoots.add(packageRoot);
}

function seedFlameworkBuildInfoCandidates(modulePath: string, workspaceBuildArtifacts: Array<string>) {
	if (workspaceBuildArtifacts.length === 0) return;

	const packageRoot = findPackageRoot(modulePath);
	if (!packageRoot) return;
	patchFlameworkBuildInfoCache(packageRoot, workspaceBuildArtifacts);

	// eslint-disable-next-line @typescript-eslint/no-require-imports -- seed Flamework's package-local cache
	const { Cache } = require(path.join(packageRoot, "out/util/cache.js")) as {
		Cache: {
			buildInfoCandidates?: Array<string>;
			moduleResolution?: Map<string, unknown>;
			pkgJsonCache?: Map<string, unknown>;
			realPath?: Map<string, string>;
			shouldView?: Map<string, boolean>;
		};
	};

	const candidates = new Array<string>();
	for (const artifactPath of workspaceBuildArtifacts) {
		if (path.basename(artifactPath) === "flamework.build" && fs.pathExistsSync(artifactPath)) {
			candidates.push(artifactPath);
		}
	}

	if (candidates.length > 0) {
		const nextCandidates = [...new Set(candidates.map(v => fs.realpathSync(v)))];
		const currentCandidates = Cache.buildInfoCandidates;
		const candidatesChanged =
			currentCandidates === undefined ||
			currentCandidates.length !== nextCandidates.length ||
			currentCandidates.some((candidate, index) => candidate !== nextCandidates[index]);

		if (candidatesChanged) {
			Cache.buildInfoCandidates = nextCandidates;
			Cache.shouldView?.clear();
		}
	}
}

function getTransformerFromFactory(factory: PluginFactory, config: TransformerPluginConfig, program: ts.Program) {
	const { after, afterDeclarations, type, ...manualConfig } = config;
	let transformer: TransformerPlugin;
	switch (type) {
		case undefined:
		case "program":
			transformer = (factory as ProgramPattern)(program, manualConfig, { ts });
			break;
		case "checker":
			transformer = (factory as TypeCheckerPattern)(program.getTypeChecker(), manualConfig);
			break;
		case "compilerOptions":
			transformer = (factory as CompilerOptionsPattern)(program.getCompilerOptions(), manualConfig);
			break;
		case "config":
			transformer = (factory as ConfigPattern)(manualConfig);
			break;
		case "raw":
			transformer = (ctx: ts.TransformationContext) => (factory as RawPattern)(ctx, program, manualConfig);
			break;
		default:
			return undefined;
	}

	if (typeof transformer === "function") {
		if (after) {
			return { after: transformer };
		} else if (afterDeclarations) {
			return { afterDeclarations: transformer as ts.TransformerFactory<ts.SourceFile | ts.Bundle> };
		}
		return { before: transformer };
	}
	return transformer;
}

export function flattenIntoTransformers(
	transformers: ts.CustomTransformers,
): Array<ts.TransformerFactory<ts.SourceFile | ts.Bundle>> {
	const result: Array<ts.TransformerFactory<ts.SourceFile | ts.Bundle>> = [];
	result.push(
		...(transformers.after as Array<ts.TransformerFactory<ts.SourceFile | ts.Bundle>>),
		...(transformers.before as Array<ts.TransformerFactory<ts.SourceFile | ts.Bundle>>),
		...(transformers.afterDeclarations as Array<ts.TransformerFactory<ts.SourceFile | ts.Bundle>>),
	);
	return result;
}

export function createTransformerList(
	program: ts.Program,
	configs: Array<TransformerPluginConfig>,
	baseDir: string,
	workspaceBuildArtifacts: Array<string> = [],
): ts.CustomTransformers {
	const transforms: ts.CustomTransformers = {
		before: [],
		after: [],
		afterDeclarations: [],
	};
	for (const config of configs) {
		if (!config.transform) continue;

		try {
			const modulePath = resolve.sync(config.transform, { basedir: baseDir });

			// eslint-disable-next-line @typescript-eslint/no-require-imports -- need to require the transformer
			const commonjsModule: PluginFactory | { [key: string]: PluginFactory } = require(modulePath);
			if (config.transform === "rbxts-transformer-flamework") {
				seedFlameworkBuildInfoCandidates(modulePath, workspaceBuildArtifacts);
			}

			const factoryModule = typeof commonjsModule === "function" ? { default: commonjsModule } : commonjsModule;
			const factory = factoryModule[config.import ?? "default"];

			if (!factory || typeof factory !== "function") throw new Error("factory not a function");

			const transformer = getTransformerFromFactory(factory, config, program);
			if (transformer) {
				if (transformer.afterDeclarations) {
					transforms.afterDeclarations?.push(transformer.afterDeclarations);
				}
				if (transformer.after) {
					transforms.after?.push(transformer.after);
				}
				if (transformer.before) {
					transforms.before?.push(transformer.before);
				}
			}
		} catch (err) {
			DiagnosticService.addDiagnostic(warnings.transformerNotFound(config.transform, err));
		}
	}

	return transforms;
}
