import fs from "fs-extra";
import path from "path";
import { getCanonicalFileName } from "Shared/util/getCanonicalFileName";
import { realPathExistsSync } from "Shared/util/realPathExistsSync";

export function createNodeModulesPathMapping(typeRoots: Array<string>) {
	const nodeModulesPathMapping = new Map<string, string>();
	const setPathMapping = (typesPath: string, mainPath: string) => {
		nodeModulesPathMapping.set(getCanonicalFileName(path.resolve(typesPath)), path.resolve(mainPath));
	};
	// go through each org
	for (const scopePath of typeRoots) {
		if (fs.pathExistsSync(scopePath)) {
			// map module paths
			for (const pkgName of fs.readdirSync(scopePath)) {
				const pkgPath = path.join(scopePath, pkgName);
				const pkgJsonPath = realPathExistsSync(path.join(pkgPath, "package.json"));
				if (pkgJsonPath !== undefined) {
					const pkgJson = fs.readJsonSync(pkgJsonPath) as {
						main?: string;
						typings?: string;
						types?: string;
					};
					// both "types" and "typings" are valid
					const typesPath = pkgJson.types ?? pkgJson.typings ?? "index.d.ts";
					if (pkgJson.main) {
						setPathMapping(path.join(pkgPath, typesPath), path.join(pkgPath, pkgJson.main));

						const realPkgPath = path.dirname(pkgJsonPath);
						setPathMapping(path.join(realPkgPath, typesPath), path.join(pkgPath, pkgJson.main));
					}
				}
			}
		}
	}
	return nodeModulesPathMapping;
}
