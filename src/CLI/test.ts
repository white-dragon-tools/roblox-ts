/// <reference types="jest" />

import { execFileSync } from "child_process";
import fs from "fs-extra";
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
	const leafOutDir = path.join(fixtureRoot, "packages", "leaf", "out");
	const appOutDir = path.join(fixtureRoot, "packages", "app", "out");

	function ensureSymlink(target: string, linkPath: string) {
		if (!fs.existsSync(linkPath)) fs.symlinkSync(target, linkPath);
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

	it("legacy --workspace produces emit", () => {
		clean();
		runCli([]);
		legacy = snapshotEmit();
		expect(legacy.leafInit).toContain("Hello, ");
		expect(legacy.appMain).toContain('"@ws"');
		expect(legacy.appMain).toContain('"leaf"');
	});

	it("--useSolutionBuilder produces emit", () => {
		clean();
		runCli(["--useSolutionBuilder"]);
		solutionBuilder = snapshotEmit();
		expect(solutionBuilder.leafInit).toBeTruthy();
		expect(solutionBuilder.appMain).toBeTruthy();
	});

	it("both drivers emit byte-equal Luau", () => {
		expect(solutionBuilder.leafInit).toBe(legacy.leafInit);
		expect(solutionBuilder.appMain).toBe(legacy.appMain);
	});

	it("--useSolutionBuilder reports node_modules import with missing emit", () => {
		clean();
		const leafPackageJsonPath = path.join(fixtureRoot, "packages", "leaf", "package.json");
		const original = fs.readFileSync(leafPackageJsonPath, "utf8");
		try {
			fs.writeFileSync(leafPackageJsonPath, original.replace("out/init.luau", "out/missing.luau"));
			expect(() => runCli(["--useSolutionBuilder"])).toThrow();
		} finally {
			fs.writeFileSync(leafPackageJsonPath, original);
			clean();
		}
	});
});
