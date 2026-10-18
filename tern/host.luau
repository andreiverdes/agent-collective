-- The Collective block: the sessions of one agent-collective profile, refreshed from
-- `agent-collective list --json`, with a composer that sends through `agent-collective send`.
-- The window half (window.luau) publishes what only a window knows into tern.kv: its panes and
-- the agents waiting for input under "win:<block pane>", the last focused pane under "focus".

local ui = tern.ui

local REFRESH_MS = 2000
local SENDER = "you (via Tern)"
local HOME = tern.getenv("HOME") or ""
local STATE_ORDER = { working = 1, quiet = 2, idle = 3, offline = 4 }
local FILTERS = {
	{ id = "all", label = "All" },
	{ id = "window", label = "This window" },
	{ id = "working", label = "Working" },
	{ id = "offline", label = "Offline" },
}

local function pane_key(n: any): string
	if type(n) == "number" then
		return string.format("%.0f", n)
	end
	return tostring(n)
end

local function tilde(path: string?): string
	if not path or path == "" then
		return "—"
	end
	if HOME ~= "" and string.sub(path, 1, #HOME) == HOME then
		return "~" .. string.sub(path, #HOME + 1)
	end
	return path
end

local function basename(path: string?): string
	if not path or path == "" then
		return "—"
	end
	return string.match(path, "([^/]+)/*$") or path
end

local function expand(path: string): string
	if string.sub(path, 1, 2) == "~/" then
		return HOME .. string.sub(path, 2)
	end
	return path
end

local function ago(ms: number?): string
	if type(ms) ~= "number" then
		return ""
	end
	local s = math.max(0, os.time() - math.floor(ms / 1000))
	if s < 60 then
		return string.format("%ds", s)
	elseif s < 3600 then
		return string.format("%dm", s // 60)
	elseif s < 86400 then
		return string.format("%dh", s // 3600)
	end
	return string.format("%dd", s // 86400)
end

local function first_line(text: string?): string
	local line = string.match(text or "", "^[^\n]*") or ""
	if #line > 120 then
		line = string.sub(line, 1, 117) .. "…"
	end
	return line
end

-- Settings: a value set from the palette (tern.kv) wins over the daemon's environment.
local function setting(key: string, env: string): string?
	local v = tern.kv.get(key)
	if type(v) == "string" and v ~= "" then
		return expand(v)
	end
	local e = tern.getenv(env)
	if e and e ~= "" then
		return expand(e)
	end
	return nil
end

local function cli_path(): (string?, string?)
	local set = setting("cli", "AGENT_COLLECTIVE_CLI")
	if set then
		if tern.fs.exists(set) then
			return set, nil
		end
		return nil, "The CLI path set for this plugin does not exist: " .. set
	end
	local candidates = {
		HOME .. "/.omp/plugins/node_modules/agent-collective/dist/agent-collective.js",
		-- Linked from a checkout: the plugin is <repo>/tern, the CLI <repo>/bin.
		tern.plugin.dir .. "/../bin/agent-collective.ts",
	}
	for _, c in candidates do
		if tern.fs.exists(c) then
			return c, nil
		end
	end
	return nil, "The agent-collective CLI was not found. Looked in:\n" .. table.concat(candidates, "\n")
end

-- Runtimes, by absolute path: Tern's PATH may be minimal. Node needs 22.18+ to run .ts files.
local function runtime_candidates(): { string }
	local list = {}
	local seen = {}
	local function add(p: string)
		if not seen[p] then
			seen[p] = true
			table.insert(list, p)
		end
	end
	for _, dir in { HOME .. "/.bun/bin", "/opt/homebrew/bin", "/usr/local/bin" } do
		add(dir .. "/bun")
	end
	for _, dir in { "/opt/homebrew/bin", "/usr/local/bin", HOME .. "/.volta/bin", HOME .. "/.local/bin" } do
		add(dir .. "/node")
	end
	local ok, versions = pcall(tern.fs.list, HOME .. "/.nvm/versions/node")
	if ok then
		table.sort(versions, function(a, b)
			local a1, a2 = string.match(a, "^v(%d+)%.(%d+)")
			local b1, b2 = string.match(b, "^v(%d+)%.(%d+)")
			local an, bn = (tonumber(a1) or 0) * 1000 + (tonumber(a2) or 0), (tonumber(b1) or 0) * 1000 + (tonumber(b2) or 0)
			return an > bn
		end)
		for _, v in versions do
			add(HOME .. "/.nvm/versions/node/" .. v .. "/bin/node")
		end
	end
	for dir in string.gmatch(tern.getenv("PATH") or "", "[^:]+") do
		add(dir .. "/bun")
		add(dir .. "/node")
	end
	return list
end

local node_ok: { [string]: boolean } = {}

local function check_node(path: string, cb: (boolean) -> ())
	if node_ok[path] ~= nil then
		cb(node_ok[path])
		return
	end
	local ok = pcall(tern.process.run, { path, "--version" }, { timeout_ms = 5000 }, function(r)
		local major, minor = string.match(r.stdout or "", "v(%d+)%.(%d+)")
		local m, n = tonumber(major) or 0, tonumber(minor) or 0
		node_ok[path] = r.status == 0 and (m > 22 or (m == 22 and n >= 18))
		cb(node_ok[path])
	end)
	if not ok then
		node_ok[path] = false
		cb(false)
	end
end

local cached_runtime: string? = nil
local cached_for: string? = nil

-- Calls cb(runtime) or cb(nil, why).
local function resolve_runtime(cb: (string?, string?) -> ())
	local set = setting("runtime", "AGENT_COLLECTIVE_RUNTIME")
	local key = set or ""
	if cached_runtime and cached_for == key and tern.fs.exists(cached_runtime) then
		cb(cached_runtime)
		return
	end
	local candidates = if set then { set } else runtime_candidates()
	local i = 0
	local function next_candidate()
		i += 1
		local c = candidates[i]
		if not c then
			if set then
				cb(nil, "The runtime set for this plugin is missing or older than Node 22.18: " .. set)
			else
				cb(nil, "Neither bun nor Node 22.18+ was found (looked in ~/.bun/bin, /opt/homebrew/bin, /usr/local/bin, ~/.volta/bin, ~/.nvm and PATH).")
			end
			return
		end
		if not tern.fs.exists(c) then
			next_candidate()
			return
		end
		local function accept()
			cached_runtime, cached_for = c, key
			cb(c)
		end
		if string.match(c, "bun$") then
			accept()
		else
			check_node(c, function(ok)
				if ok then
					accept()
				else
					next_candidate()
				end
			end)
		end
	end
	next_candidate()
end

-- Runs the CLI with `args`; cb(result) or cb(nil, why) when it can't start.
local function run_cli(args: { string }, cb: (any, string?) -> ())
	local cli, why = cli_path()
	if not cli then
		cb(nil, why)
		return
	end
	resolve_runtime(function(runtime, err)
		if not runtime then
			cb(nil, err)
			return
		end
		-- bun would otherwise auto-install missing imports; the CLI has none to fetch.
		local argv = if string.match(runtime, "bun$") then { runtime, "--no-install", cli } else { runtime, cli }
		for _, a in args do
			table.insert(argv, a)
		end
		local ok, spawn_err = pcall(tern.process.run, argv, {
			cwd = if HOME ~= "" then HOME else nil,
			env = { NODE_NO_WARNINGS = "1" },
			timeout_ms = 20000,
		}, function(r)
			cb(r)
		end)
		if not ok then
			cb(nil, "Could not start " .. runtime .. ": " .. tostring(spawn_err))
		end
	end)
end

local function stderr_line(r: any): string
	local text = (r.stderr ~= "" and r.stderr) or r.stdout or ""
	text = string.gsub(text, "%s+$", "")
	if text == "" then
		return if r.timed_out then "timed out" else "exit " .. tostring(r.status)
	end
	return first_line(string.match(text, "[^\n]*$") or text)
end

local function profiles(): { string }
	local list = {}
	local root = HOME .. "/.agent-collective"
	local ok, names = pcall(tern.fs.list, root)
	if ok then
		for _, name in names do
			if not string.find(name, ".", 1, true) and pcall(tern.fs.list, root .. "/" .. name) then
				table.insert(list, name)
			end
		end
	end
	if not table.find(list, "default") then
		table.insert(list, 1, "default")
	end
	return list
end

local function win(st): { [string]: any }
	local v = tern.kv.get("win:" .. pane_key(st.cx.pane))
	return if type(v) == "table" then v else {}
end

local function tern_pane(e): string?
	local where = e.where
	if type(where) == "table" and type(where.tern) == "table" and where.tern.pane then
		return tostring(where.tern.pane)
	end
	return nil
end

local function shown_state(st, e): string
	local pane = tern_pane(e)
	local waiting = win(st).waiting
	if pane and type(waiting) == "table" and waiting[pane] and e.state ~= "offline" then
		return "waiting"
	end
	return e.state or "offline"
end

local function filtered(st): { any }
	local out = {}
	local panes = win(st).panes
	for _, e in st.sessions or {} do
		local keep = true
		if st.filter == "window" then
			local pane = tern_pane(e)
			keep = pane ~= nil and type(panes) == "table" and panes[pane] ~= nil
		elseif st.filter == "working" then
			keep = e.state == "working"
		elseif st.filter == "offline" then
			keep = e.state == "offline"
		end
		if keep then
			table.insert(out, e)
		end
	end
	return out
end

local function selected_entry(st): any
	for _, e in st.sessions or {} do
		if e.callsign == st.selected then
			return e
		end
	end
	return nil
end

-- Keeps the selection on a visible row.
local function fix_selection(st)
	local rows = filtered(st)
	for _, e in rows do
		if e.callsign == st.selected then
			return
		end
	end
	st.selected = if rows[1] then rows[1].callsign else nil
end

local function render(st)
	if not st.alive then
		return
	end
	local ok = pcall(st.cx.render, st.cx)
	if not ok then
		st.alive = false
	end
end

-- The latest message of the selected session's log, for the detail card.
local function load_last(st, e)
	if not e or not e.sessionId or st.thread_ok == false then
		return
	end
	local callsign = e.callsign
	run_cli({ "thread", "--profile", st.profile, "--session", e.sessionId, "--json" }, function(r)
		if not r or r.status ~= 0 then
			if r then
				st.thread_ok = false
			end
			render(st)
			return
		end
		local ok, doc = pcall(tern.json.decode, r.stdout)
		if ok and type(doc) == "table" and type(doc.messages) == "table" then
			st.thread_ok = true
			st.last[callsign] = doc.messages[#doc.messages] or false
		else
			st.thread_ok = false
		end
		render(st)
	end)
end

local function open_thread(st, e)
	if not e or not e.sessionId then
		return
	end
	st.thread = { callsign = e.callsign, loading = true }
	local callsign = e.callsign
	run_cli({ "thread", "--profile", st.profile, "--session", e.sessionId, "--json" }, function(r, why)
		if not st.thread or st.thread.callsign ~= callsign then
			return
		end
		st.thread.loading = false
		if not r then
			st.thread.error = why
		elseif r.status ~= 0 then
			st.thread.error = stderr_line(r)
		else
			local ok, doc = pcall(tern.json.decode, r.stdout)
			if ok and type(doc) == "table" and type(doc.messages) == "table" then
				st.thread.messages = doc.messages
			else
				st.thread.error = "The CLI printed no thread JSON."
			end
		end
		render(st)
	end)
end

-- Picks the profile whose sessions include the pane focused before this block opened.
local function choose_profile(st, done: () -> ())
	local focus = tern.kv.get("focus")
	if #st.profiles < 2 or type(focus) ~= "string" then
		st.profile = "default"
		done()
		return
	end
	local pending = #st.profiles
	local found = nil
	for _, p in st.profiles do
		run_cli({ "list", "--profile", p, "--json" }, function(r)
			if r and r.status == 0 and not found then
				local ok, doc = pcall(tern.json.decode, r.stdout)
				if ok and type(doc) == "table" then
					for _, e in doc.sessions or {} do
						if tern_pane(e) == focus then
							found = p
						end
					end
				end
			end
			pending -= 1
			if pending == 0 then
				st.profile = found or "default"
				done()
			end
		end)
	end
end

local function refresh(st)
	if st.loading or not st.alive then
		return
	end
	if not st.profile then
		st.loading = true
		choose_profile(st, function()
			st.loading = false
			refresh(st)
		end)
		return
	end
	st.profiles = profiles()
	st.loading = true
	local profile = st.profile
	run_cli({ "list", "--profile", profile, "--json" }, function(r, why)
		st.loading = false
		if profile ~= st.profile then
			refresh(st)
			return
		end
		if not r then
			st.error = why
			st.sessions = nil
		elseif r.status ~= 0 then
			st.error = "agent-collective list failed: " .. stderr_line(r)
		else
			local ok, doc = pcall(tern.json.decode, r.stdout)
			if ok and type(doc) == "table" and type(doc.sessions) == "table" then
				local list = doc.sessions
				table.sort(list, function(a, b)
					local ra, rb = STATE_ORDER[a.state] or 5, STATE_ORDER[b.state] or 5
					if ra ~= rb then
						return ra < rb
					end
					return (a.callsign or "") < (b.callsign or "")
				end)
				st.sessions = list
				st.error = nil
				st.loaded_at = os.time()
				local had = st.selected
				fix_selection(st)
				local e = selected_entry(st)
				if e and (had ~= st.selected or st.last[e.callsign] == nil) then
					load_last(st, e)
				end
			else
				st.error = "agent-collective list printed no session JSON."
			end
		end
		render(st)
	end)
end

local function alive_on_host(st): boolean
	local ok, panes = pcall(tern.pane.list)
	if not ok then
		return true
	end
	for _, p in panes do
		if p.pane == st.cx.pane then
			return true
		end
	end
	return false
end

local function tick(st)
	if not st.alive then
		return
	end
	if not alive_on_host(st) then
		st.alive = false
		return
	end
	refresh(st)
	render(st)
	tern.timer(REFRESH_MS, function()
		tick(st)
	end)
end

local function select_by(st, delta: number)
	local rows = filtered(st)
	if #rows == 0 then
		return false
	end
	local at = 1
	for i, e in rows do
		if e.callsign == st.selected then
			at = i
		end
	end
	at = math.clamp(at + delta, 1, #rows)
	if rows[at].callsign == st.selected then
		return false
	end
	st.selected = rows[at].callsign
	load_last(st, rows[at])
	return true
end

local function go_to_pane(st)
	local e = selected_entry(st)
	local pane = e and tern_pane(e)
	if not pane then
		return
	end
	-- The window half claims this link and focuses the pane (window.luau).
	st.cx:open("agent-collective:focus/" .. pane)
end

local function send(st)
	local e = selected_entry(st)
	local text = st.draft
	if not e or string.match(text, "^%s*$") then
		return
	end
	if st.sending then
		return
	end
	st.sending = true
	local callsign = e.callsign
	run_cli({ "send", "--profile", st.profile, callsign, text }, function(r, why)
		st.sending = false
		if not r then
			st.cx:toast("error", "Not sent to " .. callsign, why)
		elseif r.status == 0 then
			st.cx:toast("success", first_line(string.gsub(r.stdout, "%s+$", "")))
			if st.draft == text then
				st.draft, st.cursor = "", 0
			end
			st.last[callsign] = nil
			load_last(st, e)
		elseif r.status == 2 then
			st.cx:toast("error", callsign .. " is offline or unknown", stderr_line(r))
		else
			st.cx:toast("error", "Not sent to " .. callsign, stderr_line(r))
		end
		render(st)
	end)
end

-- Views ---------------------------------------------------------------------------------------

local STATE_STYLE = {
	working = "accent",
	idle = "success",
	quiet = "warning",
	waiting = "warning strong",
	offline = "muted",
}
local BADGE_TONE = {
	working = "accent",
	idle = "success",
	quiet = "warning",
	waiting = "warning",
	offline = "muted",
}

local function state_text(st, e): string
	local s = shown_state(st, e)
	if s == "waiting" then
		return "waiting input"
	elseif s == "quiet" then
		return "quiet " .. ago(e.beatAt)
	elseif s == "offline" then
		local t = ago(e.lastRanAt)
		return if t ~= "" then "offline " .. t else "offline"
	end
	return s
end

-- The pane cell: the window's label for a Tern pane here (tab position, `.n` in a split), `tern`
-- for a Tern pane elsewhere, else where the session runs. The second result: Go to pane works.
local function pane_label(st, e): string?
	local pane = tern_pane(e)
	local labels = win(st).panes
	if pane and type(labels) == "table" and type(labels[pane]) == "string" then
		return labels[pane]
	end
	return nil
end

local function pane_text(st, e): (string, boolean)
	if tern_pane(e) then
		return (pane_label(st, e) or "tern") .. " ↗", true
	end
	local where = e.where
	if type(where) == "table" then
		if where.herdr then
			return "herdr", false
		elseif where.tty then
			return "tty", false
		end
	end
	return "—", false
end

-- A button: any node with `actions = {click = act}` reports an `action` event when clicked.
local function button(label: string, act: string, opts: { primary: boolean?, disabled: boolean? }?)
	local classes = { "ac-btn" }
	if opts and opts.primary then
		table.insert(classes, "ac-primary")
	end
	local disabled = opts and opts.disabled
	if disabled then
		table.insert(classes, "ac-disabled")
	end
	return ui.el("button", {
		text = label,
		class = table.concat(classes, " "),
		actions = if disabled then nil else { click = act },
		attrs = if disabled then { ["aria-disabled"] = "true" } else nil,
	})
end

local function last_text(e, m): string
	local when = os.date("%H:%M", math.floor((m.at or 0) / 1000))
	local route = if m.dir == "in" then m.peer .. " → " .. e.callsign else e.callsign .. " → " .. m.peer
	if m.outcome then
		route ..= " · " .. m.outcome
	end
	return string.format("%s  %s  “%s”", when, route, first_line(m.body))
end

local function detail(st, e)
	local harness = e.via
	if harness and e.model then
		harness ..= " · " .. e.model
	end
	local turn
	local s = shown_state(st, e)
	if s == "working" then
		turn = { ui.span("working " .. ago(e.busySince), "accent") }
	elseif s == "waiting" then
		turn = { ui.span("waiting for input", "warning") }
	else
		turn = { ui.span(state_text(st, e), STATE_STYLE[s]) }
	end
	local rows = { { "callsign", { ui.span(e.callsign, "strong") } } }
	if harness then
		table.insert(rows, { "harness", harness })
	end
	if e.cwd then
		table.insert(rows, { "directory", { ui.path(tilde(e.cwd)) } })
	end
	table.insert(rows, { "turn", turn })
	local last = st.last[e.callsign]
	if type(last) == "table" then
		table.insert(rows, { "last", last_text(e, last) })
	end
	local label = pane_label(st, e)
	local actions = {
		button(if label then "Go to pane " .. label else "Go to pane", "goto", {
			primary = true,
			disabled = tern_pane(e) == nil,
		}),
	}
	if st.thread_ok ~= false and e.sessionId then
		table.insert(actions, button("Thread", "thread"))
	end
	table.insert(actions, button("Copy callsign", "copy"))
	return ui.card({ ui.span(e.callsign, "strong"), ui.span("  " .. state_text(st, e), STATE_STYLE[s]) }, {
		ui.kv(rows),
		ui.row(actions),
	})
end

-- The sessions as an HTML-subset table: a row click selects (`select=<callsign>`), and the
-- state cell holds a badge, which `tern.ui.table` cells (spans only) can't.
local function sessions_table(st, rows)
	local head = ui.el("thead", nil, {
		ui.el("tr", nil, {
			ui.el("th", { text = "callsign" }),
			ui.el("th", { text = "state" }),
			ui.el("th", { text = "directory" }),
			ui.el("th", { text = "pane", class = "ac-pane" }),
		}),
	})
	local body = {}
	for _, e in rows do
		local s = shown_state(st, e)
		local classes = {}
		if e.callsign == st.selected then
			table.insert(classes, "ac-sel")
		end
		if e.state == "offline" then
			table.insert(classes, "ac-off")
		end
		local pane, linked = pane_text(st, e)
		table.insert(body, ui.el("tr", {
			key = "row-" .. e.callsign,
			class = table.concat(classes, " "),
			actions = { click = "select=" .. e.callsign },
		}, {
			ui.el("td", { text = e.callsign, class = "ac-callsign" }),
			ui.el("td", nil, { ui.badge(state_text(st, e), BADGE_TONE[s]) }),
			ui.el("td", { text = basename(e.cwd), class = "ac-dir", attrs = { title = e.cwd } }),
			ui.el("td", { text = pane, class = if linked then "ac-pane" else "ac-pane ac-dim" }),
		}))
	end
	return ui.el("table", { class = "ac-sessions", key = "sessions" }, { head, ui.el("tbody", nil, body) })
end

local function header(st)
	local n = if st.sessions then #st.sessions else 0
	local head = ui.row({
		ui.text({ ui.span("Collective", "strong"), ui.span(" · " .. (st.profile or "…") .. " · " .. n, "muted") }),
		ui.text({ ui.span(if st.loading then "↻ …" else "↻ " .. (REFRESH_MS // 1000) .. "s", "muted") }),
	})
	head.p = head.p or {}
	head.p.justify = "between"
	return head
end

local function tabs(id: string, items, active: string?)
	return ui.node("tabs", { items = items, active = active, key = id }, nil)
end

local function main_view(st)
	local children = { header(st) }
	if #st.profiles > 1 then
		local items = {}
		for _, p in st.profiles do
			table.insert(items, { id = "profile=" .. p, label = p })
		end
		table.insert(children, tabs("profiles", items, if st.profile then "profile=" .. st.profile else nil))
	end
	local fitems = {}
	for _, f in FILTERS do
		table.insert(fitems, { id = "filter=" .. f.id, label = f.label })
	end
	local ft = tabs("filters", fitems, "filter=" .. st.filter)
	table.insert(children, ft)

	if st.error then
		table.insert(children, ui.card({ ui.span("Can't read the collective", "error strong") }, {
			ui.text({ ui.span(st.error, "muted") }),
			ui.text({
				ui.span("Set the CLI path or runtime from the palette: ", "muted"),
				ui.span("Collective: Set CLI path…", "key"),
				ui.span(" ", nil),
				ui.span("Collective: Set runtime…", "key"),
			}),
		}))
		return ui.col(children)
	end
	if not st.sessions then
		table.insert(children, ui.text({ ui.span("Reading the collective…", "muted") }))
		return ui.col(children)
	end
	local rows = filtered(st)
	if #rows == 0 then
		local why = if #st.sessions == 0
			then "No sessions in profile " .. st.profile .. ". Sessions join when omp or pi starts with agent-collective installed."
			else "No sessions match this filter."
		table.insert(children, ui.text({ ui.span(why, "muted") }))
		return ui.col(children)
	end
	table.insert(children, sessions_table(st, rows))
	local e = selected_entry(st)
	if e then
		table.insert(children, detail(st, e))
	end
	return ui.col(children)
end

local function dock_view(st)
	local e = selected_entry(st)
	local placeholder = if e then "Message " .. e.callsign .. " as " .. SENDER .. "…" else "Select a session to message"
	local input = ui.node("input", {
		text = st.draft,
		cursor = st.cursor,
		placeholder = placeholder,
		prompt = { ui.span("›", "accent") },
		key = "message",
	}, nil)
	return ui.col({
		input,
		ui.text({
			ui.span(if st.sending then "Sending… · " else "Enter sends · ", "muted"),
			ui.span("arrives as from ", "muted"),
			ui.span(SENDER, "strong"),
			ui.span(", hop 0 · ↑↓ select · ⇥ filter", "muted"),
		}),
	})
end

local function thread_view(st)
	local t = st.thread
	local body = {}
	if t.loading then
		table.insert(body, ui.text({ ui.span("Reading the thread…", "muted") }))
	elseif t.error then
		table.insert(body, ui.text({ ui.span(t.error, "error") }))
	elseif not t.messages or #t.messages == 0 then
		table.insert(body, ui.text({ ui.span("No messages yet.", "muted") }))
	else
		local lines = {}
		for _, m in t.messages do
			local when = os.date("%H:%M", math.floor((m.at or 0) / 1000))
			local who = if m.dir == "in" then m.peer .. " → " .. t.callsign else t.callsign .. " → " .. m.peer
			local meta = "hop " .. tostring(m.hop or 0)
			if m.outcome then
				meta ..= " · " .. m.outcome
			end
			table.insert(lines, ui.text({
				ui.span(when .. "  ", "muted"),
				ui.span(who, if m.dir == "in" then "accent" else "strong"),
				ui.span("  " .. meta, "muted"),
			}))
			table.insert(lines, ui.md(m.body or ""))
		end
		table.insert(body, ui.col(lines))
	end
	table.insert(body, ui.row({ button("Close", "close-thread") }))
	return ui.col({
		ui.card({ ui.span("Thread · " .. t.callsign, "strong"), ui.span("  Esc closes", "muted") }, body),
	})
end

-- Block -----------------------------------------------------------------------------------------

local function insert(st, text: string)
	local before = string.sub(st.draft, 1, st.cursor)
	local after = string.sub(st.draft, st.cursor + 1)
	text = string.gsub(text, "[\r\n]+", " ")
	st.draft = before .. text .. after
	st.cursor += #text
end

-- Byte offset of the UTF-8 character boundary before/after `i`.
local function prev_boundary(s: string, i: number): number
	if i <= 0 then
		return 0
	end
	i -= 1
	while i > 0 do
		local b = string.byte(s, i + 1)
		if b < 0x80 or b >= 0xC0 then
			break
		end
		i -= 1
	end
	return i
end

local function next_boundary(s: string, i: number): number
	if i >= #s then
		return #s
	end
	i += 1
	while i < #s do
		local b = string.byte(s, i + 1)
		if b < 0x80 or b >= 0xC0 then
			break
		end
		i += 1
	end
	return i
end

tern.block.define("collective", {
	init = function(cx, args, saved)
		local st = {
			cx = cx,
			alive = true,
			profiles = profiles(),
			profile = nil,
			filter = "all",
			selected = nil,
			draft = "",
			cursor = 0,
			sessions = nil,
			error = nil,
			loading = false,
			sending = false,
			last = {},
			thread = nil,
			thread_ok = nil,
		}
		if type(saved) == "table" then
			if type(saved.profile) == "string" and table.find(st.profiles, saved.profile) then
				st.profile = saved.profile
			end
			if type(saved.filter) == "string" then
				st.filter = saved.filter
			end
			if type(saved.selected) == "string" then
				st.selected = saved.selected
			end
		end
		if args[1] and table.find(st.profiles, args[1]) then
			st.profile = args[1]
		end
		tern.timer(0, function()
			tick(st)
		end)
		return st
	end,

	title = function(st)
		return "Collective"
	end,

	view = function(st, cx)
		return {
			main = main_view(st),
			dock = dock_view(st),
			layer = if st.thread then thread_view(st) else nil,
		}
	end,

	key = function(st, key, cx)
		local name = key.name
		if name == "escape" then
			if st.thread then
				st.thread = nil
				return true
			end
			if st.draft ~= "" then
				st.draft, st.cursor = "", 0
				return true
			end
			return false
		elseif name == "enter" then
			if key.meta or key.ctrl then
				go_to_pane(st)
				return false
			end
			send(st)
			return true
		elseif name == "up" or name == "down" then
			return select_by(st, if name == "up" then -1 else 1)
		elseif name == "tab" then
			local at = 1
			for i, f in FILTERS do
				if f.id == st.filter then
					at = i
				end
			end
			at = (at - 1 + (if key.shift then -1 else 1)) % #FILTERS + 1
			st.filter = FILTERS[at].id
			fix_selection(st)
			return true
		elseif name == "backspace" then
			if st.cursor == 0 then
				return false
			end
			local from = prev_boundary(st.draft, st.cursor)
			st.draft = string.sub(st.draft, 1, from) .. string.sub(st.draft, st.cursor + 1)
			st.cursor = from
			return true
		elseif name == "delete" then
			if st.cursor >= #st.draft then
				return false
			end
			local to = next_boundary(st.draft, st.cursor)
			st.draft = string.sub(st.draft, 1, st.cursor) .. string.sub(st.draft, to + 1)
			return true
		elseif name == "left" then
			st.cursor = if key.meta then 0 else prev_boundary(st.draft, st.cursor)
			return true
		elseif name == "right" then
			st.cursor = if key.meta then #st.draft else next_boundary(st.draft, st.cursor)
			return true
		elseif name == "home" then
			st.cursor = 0
			return true
		elseif name == "end" then
			st.cursor = #st.draft
			return true
		elseif name == "paste" and key.text then
			insert(st, key.text)
			return true
		elseif key.text and key.text ~= "" and not key.ctrl and not key.meta then
			insert(st, key.text)
			return true
		end
		return false
	end,

	event = function(st, ev, cx)
		local act = ev.act or ev.item
		local value = ev.value
		if type(act) == "string" and value == nil then
			local k, v = string.match(act, "^([%w%-]+)=(.*)$")
			if k then
				act, value = k, v
			end
		end
		if act == "filter" and value then
			st.filter = value
			fix_selection(st)
		elseif act == "profile" and value then
			if value ~= st.profile then
				st.profile = value
				st.sessions = nil
				st.error = nil
				st.last = {}
				st.thread = nil
				refresh(st)
			end
		elseif act == "goto" then
			go_to_pane(st)
		elseif act == "thread" then
			open_thread(st, selected_entry(st))
		elseif act == "close-thread" then
			st.thread = nil
		elseif act == "copy" then
			local e = selected_entry(st)
			if e then
				cx:copy(e.callsign)
				cx:toast("success", "Copied " .. e.callsign)
			end
		elseif act == "select" and value then
			for _, e in st.sessions or {} do
				if e.callsign == value and st.selected ~= value then
					st.selected = value
					load_last(st, e)
				end
			end
		end
		cx:save()
	end,

	save = function(st)
		return { profile = st.profile, filter = st.filter, selected = st.selected }
	end,
})
