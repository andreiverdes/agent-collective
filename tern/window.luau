-- The window half of the Collective block. Blocks run in the daemon and can't see a window, so
-- this half publishes, for each Collective block shown here, the window's panes (with a short
-- label) and the agents waiting for input into tern.kv, and the pane focused last outside a
-- Collective block (a new block opens on that session's profile). It also focuses panes for the
-- block's "Go to pane" (the block opens agent-collective:focus/<pane>) and adds palette commands
-- to set the CLI or runtime path. The palette's "New Collective block" opens the block.

local KIND = "agent-collective.collective"
local POLL_MS = 1000

local function pane_key(n: any): string
	if type(n) == "number" then
		return string.format("%.0f", n)
	end
	return tostring(n)
end

local function is_collective(p): boolean
	return type(p) == "table" and type(p.block) == "string" and string.find(p.block, KIND, 1, true) ~= nil
end

-- Pane id -> a short label: the tab's position, `.n` for the n-th pane of a split tab, and the
-- session's name when it isn't the session shown.
local function labels(cx): { [string]: string }
	local out = {}
	local sessions = {}
	for _, s in cx.session:sessions() do
		sessions[s.id] = s
	end
	for _, t in cx.session:tabs() do
		local order = {}
		local layout = cx.session:layout(t.id)
		local function walk(node)
			if not node then
				return
			end
			if node.pane then
				table.insert(order, node.pane)
			end
			walk(node[1])
			walk(node[2])
		end
		if layout then
			walk(layout.root)
			for _, f in layout.floats do
				table.insert(order, f.pane)
			end
		end
		local base = tostring(t.position)
		local s = sessions[t.session]
		if s and not s.current then
			base = s.name .. " " .. base
		end
		for i, pane in order do
			out[pane_key(pane)] = if #order > 1 then base .. "." .. i else base
		end
	end
	for _, p in cx.session:panes() do
		local id = pane_key(p.pane)
		if not out[id] then
			out[id] = if p.parked then "parked" else "?"
		end
	end
	return out
end

local published: { [string]: string } = {}

local function publish(cx)
	local blocks = {}
	for _, p in cx.session:panes() do
		if is_collective(p) then
			table.insert(blocks, pane_key(p.pane))
		end
	end
	local live = {}
	if #blocks > 0 then
		local waiting = {}
		for _, a in cx.agents:list() do
			if a.state == "waiting_input" then
				waiting[pane_key(a.pane)] = true
			end
		end
		local record = { panes = labels(cx), waiting = waiting }
		local text = tern.json.encode(record)
		for _, id in blocks do
			live[id] = true
			if published[id] ~= text then
				tern.kv.set("win:" .. id, record)
				published[id] = text
			end
		end
	end
	for id in published do
		if not live[id] then
			tern.kv.set("win:" .. id, nil)
			published[id] = nil
		end
	end
end

local function tick(cx)
	if cx then
		local ok, err = pcall(publish, cx)
		if not ok then
			tern.log.warn("agent-collective:", err)
		end
	end
	tern.timer(POLL_MS, tick)
end
tick(nil)

-- The pane focused before a Collective block, so a new block opens on that session's profile.
tern.on("focus", function(ev, cx)
	local p = cx.session:pane(ev.pane)
	if p and not is_collective(p) then
		local id = pane_key(ev.pane)
		if tern.kv.get("focus") ~= id then
			tern.kv.set("focus", id)
		end
	end
end)

local function tern_binary(): string
	local exe = tern.getenv("TERN_ACP")
	if exe and exe ~= "" and tern.fs.exists(exe) then
		return exe
	end
	return "/Applications/Tern.app/Contents/MacOS/tern"
end

tern.route.link(function(link, cx)
	local pane = string.match(link.url, "^agent%-collective:focus/(%d+)$")
	if not pane then
		return nil
	end
	local id = tonumber(pane)
	if id and cx.session:pane(id) then
		local ok = pcall(function()
			cx.layout:focus(id)
		end)
		if ok then
			return { handled = true }
		end
	end
	-- Not in this window's sessions: `tern focus` makes every window show it.
	pcall(tern.process.run, { tern_binary(), "focus", pane }, { timeout_ms = 5000 }, function(r, cx2)
		if r.status ~= 0 and cx2 then
			cx2:toast("error", "Couldn't go to pane " .. pane, (string.gsub(r.stderr, "%s+$", "")))
		end
	end)
	return { handled = true }
end)

local function set_path(cx, key: string, what: string, hint: string)
	local current = tern.kv.get(key)
	cx:prompt({
		value = if type(current) == "string" then current else nil,
		placeholder = hint,
		action = "save",
	}):next(function(text, err, cx2)
		if text == nil then
			return
		end
		text = string.gsub(text, "^%s+", "")
		text = string.gsub(text, "%s+$", "")
		tern.kv.set(key, if text == "" then nil else text)
		if cx2 then
			cx2:toast("success", if text == "" then what .. " cleared: Collective looks it up again" else what .. " set to " .. text)
		end
	end)
end

tern.command({
	id = "set_cli",
	title = "Collective: Set CLI path…",
	run = function(cx)
		set_path(cx, "cli", "CLI path", "Path to bin/agent-collective.ts (empty: find it)")
	end,
})

tern.command({
	id = "set_runtime",
	title = "Collective: Set runtime…",
	run = function(cx)
		set_path(cx, "runtime", "Runtime", "Path to bun or Node 22.18+ (empty: find it)")
	end,
})
