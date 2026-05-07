# roblox-ts CLI

This handles the command line interface (CLI) entry point for roblox-ts.

The CLI should create Project instances as needed based on input from the user.

Only behavior unique to CLI environments should go here. Any behavior that is common to both the CLI and the playground environments belongs in Project.

## Structure

**commands/** - stores all of the yargs-based subcommands for the cli interface

**commands/build.ts** - the `build` command, this runs by default and can have the following flags:

-   `--project, -p` - Location of the tsconfig.json or folder containing the tsconfig.json _(defaults to ".")_
-   `--workspace` - Build all tsconfig projects in a pnpm workspace via TypeScript's `createSolutionBuilder`. Discovers members from `pnpm-workspace.yaml`, derives the project-reference graph from `workspace:*` deps, auto-injects `composite` / `declaration` / `skipLibCheck` for any package depended on by another workspace member, and propagates `WORKSPACE_BUILD_ARTIFACTS` (currently `flamework.build`) through the dependency graph for cross-package transformer macros.
-   `--watch, -w` - Enable watch mode, recompiles files as they change. With `--workspace`, this uses SolutionBuilder watch mode plus a chokidar watcher over each member's `package.json`. _(defaults to false)_
-   `--includePath, -i` - Path to where the runtime library files should be stored. _(defaults to "include")_
-   `--rojo` - Path to the Rojo configuration file. By default this will attempt to find a \*.project.json in your project folder.

**modules/** - stores various classes related to running CLI processes

**modules/Initializer.ts** - used to create projects from templates using the `init` command.

**cli.ts** - used to kickstart yargs
