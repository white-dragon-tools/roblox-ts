local roblox = require("@lune/roblox")
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
local task = require("@lune/task")

local placePath = process.args[1]

local game = roblox.deserializePlace(fs.readFile(placePath))

local function tableJoin(...)
	local result = {}
	for i = 1, select("#", ...) do
		for k, v in select(i, ...) do
			result[k] = v
		end
	end
	return result
end

local function tick()
	return os.clock()
end

game:GetService("Workspace")

roblox.implementMethod("Instance", "WaitForChild", function(self, ...)
	return self:FindFirstChild(...)
end)

roblox.implementProperty("RunService", "Heartbeat", function()
	return {}
end, function() end)

local SharedTable = {}

function SharedTable.new()
	return setmetatable({
		items = {},
	}, {
		__index = function(self, key)
			return self.items[key]
		end,
		__newindex = function(self, key, value)
			self.items[key] = value
		end,
		__iter = function(self)
			return next, self.items
		end,
	})
end

local robloxRequire

local function runRobloxScript(script: LuaSourceContainer)
	local callableFn = luau.load(luau.compile(script.Source), {
		debugName = script:GetFullName(),
		environment = tableJoin(roblox, {
			game = game,
			script = script,
			require = robloxRequire,
			tick = tick,
			task = task,
			SharedTable = SharedTable,
		}),
	})

	return callableFn()
end

local requireCache = {}

function robloxRequire(moduleScript: ModuleScript)
	local scriptPath = moduleScript:GetFullName()
	local cached = requireCache[scriptPath]
	if cached then
		return table.unpack(cached)
	end

	local result = table.pack(runRobloxScript(moduleScript))
	requireCache[scriptPath] = result
	return table.unpack(result)
end

runRobloxScript(game.ServerScriptService.app.main)
