interface ServerScriptService extends Instance {
	tests: Folder;
}

interface SharedTable extends Iterable<LuaTuple<[string | number, SharedTableValue]>> {}
