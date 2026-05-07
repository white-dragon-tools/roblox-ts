/// <reference types="jest" />

import { execFileSync } from "child_process";
import fs from "fs-extra";
import os from "os";
import path from "path";
import { compileFiles } from "Project/functions/compileFiles";
import { copyFiles } from "Project/functions/copyFiles";
import { copyInclude } from "Project/functions/copyInclude";
import { createPathTranslator } from "Project/functions/createPathTranslator";
import { createProjectData } from "Project/functions/createProjectData";
import { createProjectProgram } from "Project/functions/createProjectProgram";
import { getChangedSourceFiles } from "Project/functions/getChangedSourceFiles";
import { DEFAULT_PROJECT_OPTIONS, PACKAGE_ROOT, TS_EXT, TSX_EXT } from "Shared/constants";
import { DiagnosticFactory, errors, getDiagnosticId } from "Shared/diagnostics";
import { assert } from "Shared/util/assert";
import { formatDiagnostics } from "Shared/util/formatDiagnostics";
import { getRootDirs } from "Shared/util/getRootDirs";
import { isPathDescendantOf } from "Shared/util/isPathDescendantOf";

const DIAGNOSTIC_TEST_NAME_REGEX = /^(\w+)(?:\.\d+)?$/;

describe("should compile tests project", () => {
	const data = createProjectData(
		path.join(PACKAGE_ROOT, "tests", "tsconfig.json"),
		Object.assign({}, DEFAULT_PROJECT_OPTIONS, {
			project: "",
			allowCommentDirectives: true,
			optimizedLoops: true,
		}),
	);
	const program = createProjectProgram(data);
	const pathTranslator = createPathTranslator(program, data);

	// clean outDir between test runs
	fs.removeSync(program.getCompilerOptions().outDir!);

	it("should copy include files", () => copyInclude(data));

	it("should copy non-compiled files", () =>
		copyFiles(data, pathTranslator, new Set(getRootDirs(program.getCompilerOptions()))));

	const diagnosticsFolder = path.join(PACKAGE_ROOT, "tests", "src", "diagnostics");

	for (const sourceFile of getChangedSourceFiles(program)) {
		const fileName = path.relative(process.cwd(), sourceFile.fileName);
		if (isPathDescendantOf(path.normalize(sourceFile.fileName), diagnosticsFolder)) {
			let fileBaseName = path.basename(sourceFile.fileName);
			const ext = path.extname(fileBaseName);
			if (ext === TS_EXT || ext === TSX_EXT) {
				fileBaseName = path.basename(sourceFile.fileName, ext);
			}
			const diagnosticName = fileBaseName.match(DIAGNOSTIC_TEST_NAME_REGEX)?.[1] as keyof typeof errors;
			assert(diagnosticName && errors[diagnosticName], `Diagnostic test for unknown diagnostic ${fileBaseName}`);
			const expectedId = (errors[diagnosticName] as DiagnosticFactory).id;
			it(`should compile ${fileName} and report diagnostic ${diagnosticName}`, done => {
				process.env.ROBLOX_TS_EXPECTED_DIAGNOSTIC_ID = String(expectedId);
				const emitResult = compileFiles(program.getProgram(), data, pathTranslator, [sourceFile]);
				delete process.env.ROBLOX_TS_EXPECTED_DIAGNOSTIC_ID;
				if (
					emitResult.diagnostics.length > 0 &&
					emitResult.diagnostics.every(d => getDiagnosticId(d) === expectedId)
				) {
					done();
				} else if (emitResult.diagnostics.length === 0) {
					done(new Error(`Expected diagnostic ${diagnosticName} to be reported.`));
				} else {
					done(new Error("Unexpected diagnostics:\n" + formatDiagnostics(emitResult.diagnostics)));
				}
			});
		} else {
			it(`should compile ${fileName}`, done => {
				const emitResult = compileFiles(program.getProgram(), data, pathTranslator, [sourceFile]);
				if (emitResult.diagnostics.length > 0) {
					done(new Error("\n" + formatDiagnostics(emitResult.diagnostics)));
				} else {
					done();
				}
			});
		}
	}
});

describe("should build tests-monorepo with both workspace drivers", () => {
	const fixtureRoot = path.join(PACKAGE_ROOT, "tests-monorepo");
	const cliPath = path.join(PACKAGE_ROOT, "out", "CLI", "cli.js");
	const lunePath = resolveToolPath("lune");
	const rojoPath = resolveToolPath("rojo");
	const leafOutDir = path.join(fixtureRoot, "packages", "leaf", "out");
	const appOutDir = path.join(fixtureRoot, "packages", "app", "out");

	function ensureSymlink(target: string, linkPath: string) {
		// fs.existsSync follows symlinks, so a broken link reads as missing and the subsequent
		// symlinkSync would throw EEXIST. Probe the link node with lstatSync and recreate when broken.
		const stat = fs.lstatSync(linkPath, { throwIfNoEntry: false });
		if (stat === undefined) {
			fs.symlinkSync(target, linkPath);
		} else if (stat.isSymbolicLink() && !fs.existsSync(linkPath)) {
			fs.unlinkSync(linkPath);
			fs.symlinkSync(target, linkPath);
		}
	}

	function resolveToolPath(toolName: string) {
		try {
			return execFileSync("which", [toolName], { encoding: "utf8" }).trim() || undefined;
		} catch {
			return undefined;
		}
	}

	function clean() {
		fs.removeSync(leafOutDir);
		fs.removeSync(appOutDir);
		fs.removeSync(path.join(fixtureRoot, "packages", "app", "include"));
		fs.removeSync(path.join(fixtureRoot, "packages", "leaf", "tsconfig.tsbuildinfo"));
		fs.removeSync(path.join(fixtureRoot, "packages", "app", "tsconfig.tsbuildinfo"));
		fs.removeSync(path.join(fixtureRoot, ".rbxtsc-workspace-build.json"));
	}

	function runCli(extraArgs: Array<string>) {
		execFileSync("node", [cliPath, "--workspace", ...extraArgs], {
			cwd: fixtureRoot,
			stdio: "pipe",
		});
	}

	function runLune(placePath: string) {
		if (lunePath === undefined || rojoPath === undefined) {
			throw new Error("Lune runtime test requested without lune/rojo on PATH.");
		}

		return execFileSync(lunePath, ["run", path.join(fixtureRoot, "runWithLune.lua"), placePath], {
			cwd: fixtureRoot,
			encoding: "utf8",
		});
	}

	function snapshotEmit() {
		return {
			leafInit: fs.readFileSync(path.join(leafOutDir, "init.luau"), "utf8"),
			appMain: fs.readFileSync(path.join(appOutDir, "main.server.luau"), "utf8"),
		};
	}

	beforeAll(() => {
		// Symlinks are gitignored; each fresh checkout / CI run needs them rebuilt.
		fs.ensureDirSync(path.join(fixtureRoot, "node_modules", "@ws"));
		ensureSymlink("../../tests/node_modules/@rbxts", path.join(fixtureRoot, "node_modules", "@rbxts"));
		ensureSymlink("../../packages/leaf", path.join(fixtureRoot, "node_modules", "@ws", "leaf"));
	});

	let legacy: { leafInit: string; appMain: string };
	let solutionBuilder: { leafInit: string; appMain: string };

	it("legacy --workspace --legacyWorkspace produces emit", () => {
		clean();
		runCli(["--legacyWorkspace"]);
		legacy = snapshotEmit();
		expect(legacy.leafInit).toContain("Hello, ");
		expect(legacy.appMain).toContain('"@ws"');
		expect(legacy.appMain).toContain('"leaf"');
	});

	it("--workspace (default driver) produces emit", () => {
		clean();
		runCli([]);
		solutionBuilder = snapshotEmit();
		expect(solutionBuilder.leafInit).toBeTruthy();
		expect(solutionBuilder.appMain).toBeTruthy();
	});

	(lunePath !== undefined && rojoPath !== undefined ? it : it.skip)(
		"--useSolutionBuilder emits Luau that runs in Lune",
		() => {
			clean();
			runCli(["--useSolutionBuilder"]);
			const placePath = path.join(os.tmpdir(), "tests-monorepo-app.rbxlx");
			execFileSync(rojoPath!, ["build", "packages/app", "-o", placePath], {
				cwd: fixtureRoot,
				stdio: "pipe",
			});
			const output = runLune(placePath).trim().split(/\r?\n/);
			expect(output).toEqual(["Hello, monorepo!", "leaf v1.0.0"]);
		},
	);

	it("both drivers emit byte-equal Luau", () => {
		expect(solutionBuilder.leafInit).toBe(legacy.leafInit);
		expect(solutionBuilder.appMain).toBe(legacy.appMain);
	});

	it("--workspace reports node_modules import with missing emit", () => {
		clean();
		const leafPackageJsonPath = path.join(fixtureRoot, "packages", "leaf", "package.json");
		const original = fs.readFileSync(leafPackageJsonPath, "utf8");
		try {
			fs.writeFileSync(leafPackageJsonPath, original.replace("out/init.luau", "out/missing.luau"));
			expect(() => runCli([])).toThrow();
		} finally {
			fs.writeFileSync(leafPackageJsonPath, original);
			clean();
		}
	});
});

describe("should build tests-monorepo-complex with inferred workspace references", () => {
	const fixtureRoot = path.join(PACKAGE_ROOT, "tests-monorepo-complex");
	const cliPath = path.join(PACKAGE_ROOT, "out", "CLI", "cli.js");
	const appOutDir = path.join(fixtureRoot, "packages", "app", "out");
	const jsonLeafOutDir = path.join(fixtureRoot, "packages", "json-leaf", "out");

	function ensureSymlink(target: string, linkPath: string) {
		const stat = fs.lstatSync(linkPath, { throwIfNoEntry: false });
		if (stat === undefined) {
			fs.symlinkSync(target, linkPath);
		} else if (stat.isSymbolicLink() && !fs.existsSync(linkPath)) {
			fs.unlinkSync(linkPath);
			fs.symlinkSync(target, linkPath);
		}
	}

	function clean() {
		fs.removeSync(appOutDir);
		fs.removeSync(jsonLeafOutDir);
		fs.removeSync(path.join(fixtureRoot, "packages", "app", "tsconfig.tsbuildinfo"));
		fs.removeSync(path.join(fixtureRoot, "packages", "json-leaf", "tsconfig.tsbuildinfo"));
		fs.removeSync(path.join(fixtureRoot, ".rbxtsc-workspace-build.json"));
	}

	function runCli(extraArgs: Array<string>) {
		execFileSync("node", [cliPath, "--workspace", "--project", "packages/app/tsconfig.json", ...extraArgs], {
			cwd: fixtureRoot,
			stdio: "pipe",
		});
	}

	beforeAll(() => {
		fs.ensureDirSync(path.join(fixtureRoot, "node_modules", "@complex"));
		ensureSymlink("../../tests/node_modules/@rbxts", path.join(fixtureRoot, "node_modules", "@rbxts"));
		ensureSymlink("../../packages/json-leaf", path.join(fixtureRoot, "node_modules", "@complex", "json-leaf"));
	});

	afterAll(clean);

	it("--workspace includes JSON modules when auto-compositing referenced packages", () => {
		clean();
		runCli([]);
		const leafInit = fs.readFileSync(path.join(jsonLeafOutDir, "init.luau"), "utf8");
		expect(leafInit).toContain('TS.import(script, script, "config")');
	});
});
