# Workspace Migration

This branch made `--workspace` default to the SolutionBuilder driver.
This note is for the future PR that deletes the legacy in-tree pnpm
workspace path from `src/CLI/commands/build.ts`.

## 1. What’s removable

The table below lists the legacy-only symbols still in `build.ts`. Line
ranges are approximate and based on the current file.

| Symbol | Lines | SolutionBuilder depends? | Notes |
| --- | --- | --- | --- |
| `WORKSPACE_BUILD_MANIFEST_NAME` | 176 | No | Legacy manifest filename only. |
| `WorkspaceBuildManifestPackage` | 165-169 | No | Manifest shape for the old path. |
| `WorkspaceBuildManifest` | 171-174 | No | Manifest root object. |
| `createWorkspaceBuildManifest` | 224-239 | No | Writes the legacy package graph snapshot. |
| `writeWorkspaceBuildManifest` | 241-243 | No | Only used by legacy build/watch. |
| `updateWorkspaceBuildManifestPackage` | 245-260 | No | Tracks artifact paths in the manifest. |
| `getWorkspaceBuildArtifacts` | 262-290 | No | Legacy artifact propagation from the manifest. |
| `getAffectedWorkspacePackages` | 321-335 | No | Legacy watch rebuild propagation. |
| `isPackagePathAffected` | 337-344 | No | Legacy watch file filter. |
| `flushAsyncTransformerArtifacts` | 376-378 | No | Legacy build ordering hack. |
| `buildWorkspacePackages` | 380-402 | No | Legacy one-shot workspace build loop. |
| `watchWorkspacePackages` | 404-453 | No | Legacy workspace watch loop. |
| `legacyWorkspace` flag + dispatch branch | 456, 488, 569-586 | No | Opt-out path to delete after the migration window. |

Already moved out of `build.ts`:

- `WORKSPACE_BUILD_ARTIFACTS` now lives in `src/Shared/constants.ts`.
- It is still used by both drivers, so it is not removable yet.

## 2. What still needs the default path

These helpers are not legacy-only yet. The default SolutionBuilder path
still uses them to discover workspace members.

| Symbol | Lines | SolutionBuilder depends? | Notes |
| --- | --- | --- | --- |
| `findWorkspaceConfigPath` | 49-60 | Yes | Locates `pnpm-workspace.yaml`. |
| `parseWorkspacePackagePatterns` | 62-90 | Yes | Lightweight pnpm-workspace parser. |
| `getAllPackagePaths` | 92-110 | Yes | Workspace discovery traversal. |
| `patternToRegExp` | 112-130 | Yes | Glob matcher for workspace patterns. |
| `matchesWorkspacePattern` | 132-135 | Yes | Pattern test helper. |
| `getWorkspacePackagePaths` | 137-152 | Yes | Filters discovered package dirs. |
| `isWorkspaceDependency` | 154-156 | Yes | Workspace dependency heuristic. |
| `WorkspacePackage` | 158-163 | Yes | Current workspace-member source type. |
| `getWorkspacePackages` | 178-221 | Yes | Builds the package list and dependency names. |
| `orderWorkspacePackages` | 292-318 | Yes | Default path still topologically orders members before building SolutionBuilder inputs. |

`createProjectOptions` and `buildProject` also stay, but they are not
workspace-only. Single-project builds still use them.

## 3. Why it is safe to remove the legacy path

| Legacy capability | SolutionBuilder replacement | Evidence |
| --- | --- | --- |
| Build all workspace packages | `buildWorkspaceWithSolutionBuilder` | `a470d615`, `35b9700f` |
| Watch workspace changes | `watchWorkspaceWithSolutionBuilder` | `c42bc2df` |
| package.json watcher (legacy chokidar list) | chokidar inside watch driver | `27f6bbda` |
| Incremental rebuilds | `changedFilesSet` snapshot + `getChangedSourceFiles` | `5235ab14` |
| Cache invalidation across watch rebuilds | mtime-keyed `parsedCommandLineCache` | `d6f047da` |
| Cross-package Flamework artifacts | `collectWorkspaceBuildArtifacts` + `WORKSPACE_BUILD_ARTIFACTS` | `8333b85c` |
| `process.chdir` so transformer cwd resolves per-package tsconfig | chdir / restore in `afterProgramEmitAndDiagnostics` | `f1ede7a2` |
| Inferred `composite` / `declaration` / `skipLibCheck` / refs | `host.getParsedCommandLine` injection (refined to only inject composite for *referenced* members) | `35b9700f`, `a80ec0f7` |
| `resolveJsonModule` + composite | auto-add `.json` files from rootDir to fileNames | `f9a083d1` |
| `pnpm-workspace.yaml: ["."]` self-reference | empty-relative-path normalized to `"."` | `1c663e35` |
| Empty workspace discovery surfaces an error | `CLIError` instead of silent exit 0 | `1c663e35` |
| Emit validation for bad package `main` paths | `nodeModuleEmitMissing` diagnostic, with `.lua`/`.luau` extension swap tolerance | `6800c8cb`, `af2ff3b0` |
| Runtime proof of emitted monorepo Luau | Lune fixture test | `1e70def4` |
| Byte-equal regression coverage for both drivers | Jest monorepo block | `6a882eb0` |
| `resolveJsonModule` regression coverage | `tests-monorepo-complex/` fixture + jest case | `f9a083d1` |
| Real Flamework + diamond + chain soak | manual run on `/tmp/rbxts-soak-fixture` and bevy_framework | session log |

The current branch already proves the default driver can build, watch,
incrementally rebuild, carry artifacts, run real Flamework transformers,
and emit Luau that runs end-to-end under Lune.

## 4. Risks and open questions

- Real Flamework cross-package macro propagation (`Modding.Generic`,
  `Reflect.Decorator`) was exercised only via single-project bevy_framework
  and by Flamework instantiating against the per-package tsconfig in
  `/tmp/rbxts-soak-fixture`. Construct an explicit cross-package macro
  test before fully deleting legacy.
- `isWorkspaceDependency()` only recognizes `workspace:`, `link:`, and
  `file:`. Workspaces that use pnpm `catalog:` indirection are not
  inferred. No real-world report yet.
- `parseWorkspacePackagePatterns()` is a small parser, not a full YAML
  parser. It handles `packages: [...]` block style, quoted globs,
  comments, `!` exclusions, and the `.` self-reference shape; it does
  not support flow-style arrays, anchors, or every legal yaml.
- Existing project-reference de-duplication only compares resolved
  directories. It covers direct duplicates like `../leaf`, but can
  miss refs pointing at `tsconfig.json` files, symlinked paths, or
  differently cased paths on case-insensitive filesystems.
- The default path still derives `WorkspaceMember` data from package.json
  and tsconfig discovery inside `build.ts`. If that discovery logic moves
  elsewhere, the legacy helpers can be deleted cleanly. Until then, the
  parser/topology helpers are shared infrastructure, not dead code.
- `--workspace` with a member that has no internal dependents and that
  TS sees as "out of date" because of dependency tsbuildinfo timestamps
  triggers a redundant `afterProgramEmitAndDiagnostics` call whose Luau
  emit set is empty. Functionally a no-op; cosmetically a small
  performance loss vs the ideal "leaf source unchanged, skip entirely"
  case. Acceptable for now.

## 5. Suggested deletion sequence

1. Keep `--legacyWorkspace` for one release cycle while `--workspace`
   remains the default.
2. Prove `--workspace` on at least one real workspace with Flamework and
   a package graph deeper than the fixture.
3. Move any remaining workspace discovery code needed by the default
   path out of `build.ts` if you want that file to shrink further.
4. Delete the manifest-specific types, helpers, manifest writes, legacy
   rebuild/watch loops, and the `--legacyWorkspace` branch.
5. Remove the legacy warning path for `--useSolutionBuilder` and then
   drop the flag entirely.
6. Re-run `npm run build`, `npx jest --runInBand`, and the monorepo
   Lune runtime check before merging.
