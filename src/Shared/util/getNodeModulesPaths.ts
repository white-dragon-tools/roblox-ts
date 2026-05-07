import fs from "fs-extra";
import path from "path";
import { NODE_MODULES } from "Shared/constants";

function addUniquePath(paths: Array<string>, fsPath: string) {
	const normalizedPath = path.normalize(fsPath);
	if (!paths.some(v => path.normalize(v) === normalizedPath)) {
		paths.push(normalizedPath);
	}
}

export function getNodeModulesPaths(packagePath: string): Array<string> {
	const nodeModulesPaths = new Array<string>();
	for (let currentPath = packagePath; ; currentPath = path.dirname(currentPath)) {
		const nodeModulesPath = path.join(currentPath, NODE_MODULES);
		if (currentPath === packagePath || fs.pathExistsSync(nodeModulesPath)) {
			addUniquePath(nodeModulesPaths, nodeModulesPath);
		}

		const parentPath = path.dirname(currentPath);
		if (parentPath === currentPath) break;
	}
	return nodeModulesPaths;
}
