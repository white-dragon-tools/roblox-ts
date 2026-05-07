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
| Incremental rebuilds | `changedFilesSet` snapshot + `getChangedSourceFiles` | `5235ab14` |
| Cross-package Flamework artifacts | `collectWorkspaceBuildArtifacts` + `WORKSPACE_BUILD_ARTIFACTS` | `8333b85c` |
| Inferred `composite` / `declaration` / `skipLibCheck` / refs | `host.getParsedCommandLine` injection | `35b9700f` |
| Emit validation for bad package `main` paths | `nodeModuleEmitMissing` diagnostic | `6800c8cb` |
| Runtime proof of emitted monorepo Luau | Lune fixture test | `1e70def4` |
| Byte-equal regression coverage for both drivers | Jest monorepo block | `6a882eb0` |

The current branch already proves the default driver can build, watch,
incrementally rebuild, carry artifacts, and emit runnable Luau.

## 4. Risks and open questions

- The SolutionBuilder path has not been exercised against a real
  Flamework workspace, only the fixture and a synthetic artifact case.
- `isWorkspaceDependency()` only recognizes `workspace:`, `link:`, and
  `file:`. Workspace setups that lean on `catalog:` indirection or other
  pnpm variants may not be inferred correctly.
- `parseWorkspacePackagePatterns()` is a small parser, not a full YAML
  parser. It handles the current fixture shape, quoted globs, comments,
  and `!` exclusions, but not every pnpm-workspace.yaml shape.
- Existing project-reference de-duplication only compares resolved
  directories. It covers direct duplicates like `../leaf`, but it can
  miss refs that point at `tsconfig.json` files, symlinked paths, or
  differently cased paths on case-insensitive filesystems.
- The default path still derives `WorkspaceMember` data from package.json
  and tsconfig discovery inside `build.ts`. If that discovery logic moves
  elsewhere, the legacy helpers can be deleted cleanly. Until then, the
  parser/topology helpers are shared infrastructure, not dead code.

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
