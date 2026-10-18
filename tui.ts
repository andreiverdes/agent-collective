/**
 * The /collective TUI: a full-screen overlay opened with `ctx.ui.custom`, which omp and pi
 * both provide with the same factory shape `(tui, theme, keybindings, done) => Component`.
 *
 * Three modes, as in docs/design/collective-tui.bluedoc.json:
 *   list    every session in the collective: contacts, others, offline (dimmed); a detail panel
 *   thread  the message log with one peer, and a composer
 *   rename  this session's callsign
 *
 * Everything shown is read from disk through the CollectiveTuiApi, refreshed every 2 s.
 * Keys are decoded here (legacy and kitty encodings), not through a host key helper, so the
 * same code runs on both hosts and under the test harness.
 */
import { execFile } from "node:child_process";
import { formatAgo, type CollectiveEntry, type LogEntry } from "./store.ts";

/** What the TUI needs from the running node. */
export interface CollectiveTuiApi {
	scope: string;
	via: "omp" | "pi";
	callsign(): string;
	override(): string | undefined;
	entries(): (CollectiveEntry & { contact: boolean })[];
	thread(peer: string): LogEntry[];
	send(callsign: string, body: string): Promise<{ ok: boolean; outcome: string; text: string }>;
	rename(name: string): string;
	previewName(name: string): { name: string; held: boolean };
}

/** The subset of a host TUI component the overlay implements. */
export interface TuiComponent {
	render(width: number): string[];
	handleInput?(data: string): void;
	invalidate(): void;
	dispose?(): void;
}

export interface TuiLike {
	requestRender(force?: boolean): void;
	terminal?: { rows?: number; columns?: number };
}

export interface ThemeLike {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
}

/** `ctx.ui.custom` on both hosts. */
export type CustomUi = <T>(
	factory: (tui: TuiLike, theme: ThemeLike, keybindings: unknown, done: (result: T) => void) => TuiComponent | Promise<TuiComponent>,
	options?: {
		overlay?: boolean;
		overlayOptions?: { anchor?: string; width?: string | number; maxHeight?: string | number; margin?: number };
	},
) => Promise<T>;

const REFRESH_MS = 2_000;
const STATUS_MS = 4_000;

// ---------------------------------------------------------------------------------------------
// Keys

/** A decoded key press: a named key with modifiers, or typed text. */
export interface KeyPress {
	name: string;
	ctrl: boolean;
	shift: boolean;
	alt: boolean;
	/** Printable text this press types, if any. */
	text?: string;
}

const KITTY_NAMES: Record<number, string> = { 9: "tab", 13: "enter", 27: "escape", 127: "backspace" };
const CSI_NAMES: Record<string, string> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };
const TILDE_NAMES: Record<string, string> = { "1": "home", "3": "delete", "4": "end", "5": "pageUp", "6": "pageDown", "7": "home", "8": "end" };

/**
 * Decode one input chunk into key presses. Covers legacy VT sequences and the kitty keyboard
 * protocol (CSI <code>;<mods>u, release events dropped), which omp and pi enable when the
 * terminal supports it. A pasted run of text comes back as one text press.
 */
export function decodeKeys(data: string): KeyPress[] {
	const keys: KeyPress[] = [];
	const plain = (name: string, extra: Partial<KeyPress> = {}): KeyPress => ({ name, ctrl: false, shift: false, alt: false, ...extra });
	const mods = (raw: string | undefined): Pick<KeyPress, "ctrl" | "shift" | "alt"> => {
		const bits = Math.max(0, Number(raw ?? "1") - 1);
		return { shift: (bits & 1) !== 0, alt: (bits & 2) !== 0, ctrl: (bits & 4) !== 0 };
	};
	let i = 0;
	while (i < data.length) {
		const rest = data.slice(i);
		// Bracketed paste: deliver the contents as text.
		const paste = /^\x1b\[200~([\s\S]*?)\x1b\[201~/u.exec(rest);
		if (paste) {
			keys.push(plain("text", { text: paste[1] }));
			i += paste[0].length;
			continue;
		}
		const kitty = /^\x1b\[(\d+)(?::\d+)*(?:;(\d+)(?::(\d+))?)?(?:;[\d:]+)?u/u.exec(rest);
		if (kitty) {
			i += kitty[0].length;
			if (kitty[3] === "3") continue;
			const code = Number(kitty[1]);
			const modifiers = mods(kitty[2]);
			const named = KITTY_NAMES[code];
			if (named) keys.push({ name: named, ...modifiers });
			else {
				const char = String.fromCodePoint(code);
				const typed = modifiers.ctrl || modifiers.alt ? undefined : modifiers.shift ? char.toUpperCase() : char;
				keys.push({ name: char.toLowerCase(), ...modifiers, text: typed });
			}
			continue;
		}
		const csi = /^\x1b\[(?:1;(\d+)(?::(\d+))?)?([ABCDHF])/u.exec(rest) ?? /^\x1bO()()([ABCDHF])/u.exec(rest);
		if (csi) {
			i += csi[0].length;
			if (csi[2] === "3") continue;
			keys.push({ name: CSI_NAMES[csi[3]!]!, ...mods(csi[1] || undefined) });
			continue;
		}
		const tilde = /^\x1b\[(\d+)(?:;(\d+)(?::(\d+))?)?~/u.exec(rest);
		if (tilde) {
			i += tilde[0].length;
			if (tilde[3] === "3") continue;
			const named = TILDE_NAMES[tilde[1]!];
			if (named) keys.push({ name: named, ...mods(tilde[2]) });
			continue;
		}
		const char = data[i]!;
		if (char === "\x1b") {
			const next = data[i + 1];
			if (next === "\r" || next === "\n") {
				keys.push(plain("enter", { alt: true }));
				i += 2;
			} else if (next !== undefined && next >= " " && next !== "[" && next !== "O") {
				keys.push(plain(next.toLowerCase(), { alt: true }));
				i += 2;
			} else {
				keys.push(plain("escape"));
				i += 1;
			}
			continue;
		}
		if (char === "\r") keys.push(plain("enter"));
		else if (char === "\n") keys.push(plain("enter", { shift: true }));
		else if (char === "\t") keys.push(plain("tab"));
		else if (char === "\x7f" || char === "\b") keys.push(plain("backspace"));
		else if (char < " ") keys.push(plain(String.fromCharCode(char.charCodeAt(0) + 96), { ctrl: true }));
		else {
			// One press per character, so a fast burst like "/eps" is "/" then "e", "p", "s".
			const typed = String.fromCodePoint(data.codePointAt(i)!);
			keys.push(plain(typed.toLowerCase(), { text: typed }));
			i += typed.length;
			continue;
		}
		i += 1;
	}
	return keys;
}

// ---------------------------------------------------------------------------------------------
// Text measurement

const ANSI = /\x1b\[[0-9;:]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/gu;

function charWidth(code: number): number {
	if (code < 0x20 || (code >= 0x300 && code <= 0x36f) || code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f)) return 0;
	if (
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x2e80 && code <= 0xa4cf) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0x1f300 && code <= 0x1faff)
	)
		return 2;
	return 1;
}

export function visibleWidth(text: string): number {
	let width = 0;
	for (const char of text.replace(ANSI, "")) width += charWidth(char.codePointAt(0)!);
	return width;
}

/** Cut `text` to `width` columns (keeping ANSI codes), adding `…` when cut; pad with spaces if `pad`. */
export function fit(text: string, width: number, pad = true): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return pad ? text + " ".repeat(width - visibleWidth(text)) : text;
	let out = "";
	let used = 0;
	let index = 0;
	while (index < text.length) {
		ANSI.lastIndex = index;
		const escape = ANSI.exec(text);
		if (escape && escape.index === index) {
			out += escape[0];
			index += escape[0].length;
			continue;
		}
		const char = String.fromCodePoint(text.codePointAt(index)!);
		const w = charWidth(char.codePointAt(0)!);
		if (used + w > width - 1) break;
		out += char;
		used += w;
		index += char.length;
	}
	out += "…\x1b[0m";
	used += 1;
	return pad ? out + " ".repeat(Math.max(0, width - used)) : out;
}

/** Word-wrap plain text to `width` columns. */
export function wrap(text: string, width: number): string[] {
	const lines: string[] = [];
	for (const paragraph of text.split("\n")) {
		let line = "";
		for (const word of paragraph.split(/(\s+)/u)) {
			if (visibleWidth(line + word) <= width) {
				line += word;
				continue;
			}
			if (line.trim()) lines.push(line.trimEnd());
			line = word.trimStart();
			while (visibleWidth(line) > width) {
				lines.push(fit(line, width, false).replace(/…\x1b\[0m$/u, ""));
				line = line.slice(Math.max(1, width - 1));
			}
		}
		lines.push(line.trimEnd());
	}
	return lines;
}

// ---------------------------------------------------------------------------------------------
// Side effects a viewer can trigger

/** Focus the pane a session runs in. Resolves with an error text, or undefined on success. */
export function goToPane(entry: CollectiveEntry): Promise<string | undefined> {
	const { promise, resolve } = Promise.withResolvers<string | undefined>();
	const where = entry.where;
	const run = (file: string, args: string[], env?: NodeJS.ProcessEnv): void => {
		execFile(file, args, { timeout: 5_000, env: { ...process.env, ...env } }, error =>
			resolve(error ? `could not focus: ${error.message.split("\n")[0]}` : undefined),
		);
	};
	if (where?.tern) run(process.env.TERN_ACP || "tern", ["focus", where.tern.pane]);
	else if (where?.herdr) run("herdr", ["agent", "focus", where.herdr.pane], where.herdr.socket ? { HERDR_SOCKET_PATH: where.herdr.socket } : undefined);
	else resolve(`${entry.callsign} is not in a Tern or herdr pane${where?.tty ? ` (terminal ${where.tty})` : ""}`);
	return promise;
}

/** Copy to the system clipboard: pbcopy on macOS, else an OSC 52 request to the terminal. */
export function copyText(text: string): void {
	if (process.platform === "darwin") {
		const child = execFile("pbcopy", () => undefined);
		child.stdin?.end(text);
		return;
	}
	process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
}

// ---------------------------------------------------------------------------------------------
// The view

type Entry = CollectiveEntry & { contact: boolean };
type Mode = "list" | "thread" | "rename";

function whereLabel(entry: CollectiveEntry): string {
	if (entry.where?.tern) return "Tern";
	if (entry.where?.herdr) return `herdr ${entry.where.herdr.pane}`;
	if (entry.where?.tty) return `tty ${entry.where.tty.replace(/^tty/u, "")}`;
	return "—";
}

function shortDir(cwd: string | undefined): string {
	if (!cwd) return "—";
	const home = process.env.HOME;
	const path = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
	const worktree = /(\.worktrees\/[^/]+)$/u.exec(path);
	if (worktree) return worktree[1]!;
	const parts = path.split("/");
	return parts.length > 3 ? parts.slice(-1)[0]! : path;
}

function clock(ms: number): string {
	const date = new Date(ms);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export class CollectiveView implements TuiComponent {
	readonly #api: CollectiveTuiApi;
	readonly #tui: TuiLike;
	readonly #theme: ThemeLike;
	readonly #close: () => void;
	readonly #timer: ReturnType<typeof setInterval>;
	#entries: Entry[] = [];
	#mode: Mode = "list";
	#selected = 0;
	#scroll = 0;
	#filter = "";
	#filtering = false;
	#contactsOnly = false;
	#peer: string | undefined;
	#messages: LogEntry[] = [];
	#draft = "";
	#drafts = new Map<string, string>();
	#sending = false;
	#renameText = "";
	#status: { text: string; tone: string; until: number } | undefined;

	constructor(api: CollectiveTuiApi, tui: TuiLike, theme: ThemeLike, close: () => void) {
		this.#api = api;
		this.#tui = tui;
		this.#theme = theme;
		this.#close = close;
		this.#reload();
		this.#timer = setInterval(() => {
			this.#reload();
			this.#tui.requestRender();
		}, REFRESH_MS);
		this.#timer.unref?.();
	}

	dispose(): void {
		clearInterval(this.#timer);
	}

	invalidate(): void {
		// Nothing cached between renders.
	}

	#reload(): void {
		try {
			this.#entries = this.#api.entries();
			if (this.#peer !== undefined) this.#messages = this.#api.thread(this.#peer);
		} catch (error) {
			this.#say(`could not read the collective: ${String(error)}`, "error");
		}
	}

	#visible(): Entry[] {
		const needle = this.#filter.toLowerCase();
		return this.#entries.filter(
			entry =>
				(!this.#contactsOnly || entry.contact) &&
				(!needle || entry.callsign.toLowerCase().includes(needle) || (entry.cwd ?? "").toLowerCase().includes(needle)),
		);
	}

	#current(): Entry | undefined {
		const visible = this.#visible();
		return visible[Math.min(this.#selected, visible.length - 1)];
	}

	#say(text: string, tone = "muted"): void {
		this.#status = { text, tone, until: Date.now() + STATUS_MS };
	}

	// --- input -----------------------------------------------------------------------------

	handleInput(data: string): void {
		for (const key of decodeKeys(data)) {
			if (this.#mode === "list") this.#listKey(key);
			else if (this.#mode === "thread") this.#threadKey(key);
			else this.#renameKey(key);
		}
		this.#tui.requestRender();
	}

	#listKey(key: KeyPress): void {
		const count = this.#visible().length;
		const page = Math.max(1, this.#rows() - 8);
		if (this.#filtering) {
			if (key.name === "escape") {
				this.#filtering = false;
				this.#filter = "";
			} else if (key.name === "enter" || key.name === "down") this.#filtering = false;
			else if (key.name === "backspace") this.#filter = this.#filter.slice(0, -1);
			else if (key.ctrl && key.name === "u") this.#filter = "";
			else if (key.text) this.#filter += key.text;
			this.#selected = 0;
			return;
		}
		if (key.name === "up" || (key.name === "k" && !key.ctrl)) this.#selected = Math.max(0, this.#selected - 1);
		else if (key.name === "down" || (key.name === "j" && !key.ctrl)) this.#selected = Math.min(Math.max(0, count - 1), this.#selected + 1);
		else if (key.name === "pageUp") this.#selected = Math.max(0, this.#selected - page);
		else if (key.name === "pageDown") this.#selected = Math.min(Math.max(0, count - 1), this.#selected + page);
		else if (key.name === "home") this.#selected = 0;
		else if (key.name === "end") this.#selected = Math.max(0, count - 1);
		else if (key.name === "/") {
			this.#filtering = true;
		} else if (key.name === "c" && !key.ctrl) {
			this.#contactsOnly = !this.#contactsOnly;
			this.#selected = 0;
		} else if (key.name === "enter") this.#openThread();
		else if (key.name === "g" && !key.ctrl) this.#goTo();
		else if (key.name === "y" && !key.ctrl) this.#copy();
		else if (key.name === "r" && !key.ctrl) {
			this.#mode = "rename";
			this.#renameText = this.#api.override() ?? this.#api.callsign();
		} else if (key.name === "escape" || (key.name === "q" && !key.ctrl) || (key.ctrl && key.name === "c")) {
			if (this.#filter) {
				this.#filter = "";
				this.#selected = 0;
			} else this.#close();
		}
	}

	#openThread(): void {
		const entry = this.#current();
		if (!entry) return;
		this.#peer = entry.callsign;
		this.#messages = this.#api.thread(entry.callsign);
		this.#draft = this.#drafts.get(entry.callsign) ?? "";
		this.#mode = "thread";
	}

	#threadKey(key: KeyPress): void {
		if (key.name === "escape") {
			if (this.#peer !== undefined) this.#drafts.set(this.#peer, this.#draft);
			this.#mode = "list";
			this.#peer = undefined;
			return;
		}
		if (key.name === "enter" && (key.shift || key.alt)) this.#draft += "\n";
		else if (key.name === "enter") void this.#send();
		else if (key.name === "backspace") this.#draft = this.#draft.slice(0, -1);
		else if (key.ctrl && key.name === "u") this.#draft = "";
		else if (key.ctrl && key.name === "g") this.#goTo();
		else if (key.text && !key.ctrl) this.#draft += key.text;
	}

	async #send(): Promise<void> {
		const peer = this.#peer;
		const body = this.#draft.trim();
		if (!peer || !body || this.#sending) return;
		this.#sending = true;
		this.#say(`sending to ${peer}…`);
		this.#tui.requestRender();
		try {
			const result = await this.#api.send(peer, body);
			if (result.ok) {
				this.#draft = "";
				this.#drafts.delete(peer);
			}
			this.#say(result.text, result.ok ? "success" : "error");
		} catch (error) {
			this.#say(`send failed: ${String(error)}`, "error");
		} finally {
			this.#sending = false;
			this.#reload();
			this.#tui.requestRender();
		}
	}

	#renameKey(key: KeyPress): void {
		if (key.name === "escape") this.#mode = "list";
		else if (key.name === "enter") {
			const before = this.#api.callsign();
			const after = this.#api.rename(this.#renameText.trim());
			this.#say(before === after ? `callsign unchanged: ${after}` : `callsign: ${before} → ${after}`, "success");
			this.#mode = "list";
		} else if (key.ctrl && key.name === "u") {
			const after = this.#api.rename("");
			this.#say(`override cleared; callsign: ${after}`, "success");
			this.#mode = "list";
		} else if (key.name === "backspace") this.#renameText = this.#renameText.slice(0, -1);
		else if (key.text && !key.ctrl) this.#renameText += key.text.replace(/\s+/gu, "-");
	}

	#goTo(): void {
		const entry = this.#mode === "thread" ? this.#entries.find(e => e.callsign === this.#peer) : this.#current();
		if (!entry) return;
		if (entry.state === "offline") {
			this.#say(`${entry.callsign} is offline`, "warning");
			return;
		}
		void goToPane(entry).then(error => {
			if (error) this.#say(error, "warning");
			else this.#close();
			this.#tui.requestRender();
		});
	}

	#copy(): void {
		const entry = this.#current();
		if (!entry) return;
		copyText(entry.callsign);
		this.#say(`copied ${entry.callsign}`, "success");
	}

	// --- rendering -------------------------------------------------------------------------

	#rows(): number {
		return Math.max(12, this.#tui.terminal?.rows ?? process.stdout.rows ?? 30);
	}

	render(width: number): string[] {
		const rows = this.#rows();
		const lines = this.#mode === "thread" ? this.#renderThread(width, rows) : this.#renderList(width, rows);
		if (this.#mode === "rename") this.#overlayRename(lines, width, rows);
		return lines.slice(0, rows).map(line => fit(line, width));
	}

	#stateCell(entry: CollectiveEntry): string {
		const t = this.#theme;
		if (entry.state === "working") return t.fg("accent", "● working");
		if (entry.state === "idle") return t.fg("success", "○ idle");
		if (entry.state === "quiet") return t.fg("warning", "◌ quiet");
		return t.fg("dim", "– offline");
	}

	#seen(entry: CollectiveEntry): string {
		const at = entry.state === "offline" ? entry.lastRanAt : entry.beatAt;
		if (at === undefined) return "—";
		const ms = Date.now() - at;
		return ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}s` : formatAgo(ms).replace(" min", "m").replace(" h", "h").replace(" days", "d");
	}

	#header(width: number, parts: string[]): string {
		const t = this.#theme;
		return t.bg("selectedBg", fit(` ${parts.join(t.fg("dim", "  │  "))}`, width));
	}

	#footer(width: number, hints: [string, string][]): string {
		const t = this.#theme;
		const status = this.#status && this.#status.until > Date.now() ? this.#status : undefined;
		if (status) return fit(` ${t.fg(status.tone, status.text)}`, width);
		return fit(` ${hints.map(([key, label]) => `${t.bold(key)} ${t.fg("muted", label)}`).join("  ")}`, width);
	}

	#renderList(width: number, rows: number): string[] {
		const t = this.#theme;
		const entries = this.#entries;
		const running = entries.filter(e => e.state !== "offline").length;
		const quiet = entries.filter(e => e.state === "quiet").length;
		const offline = entries.length - running;
		const contacts = entries.filter(e => e.contact).length;
		const lines: string[] = [];
		lines.push(
			this.#header(width, [
				`${t.bold(t.fg("accent", "collective"))} ${this.#api.scope}`,
				`you are ${t.fg("accent", this.#api.callsign())} · ${this.#api.via}`,
				t.fg("muted", `${running} running · ${quiet} quiet · ${offline} offline · ${contacts} contacts${this.#contactsOnly ? " · contacts only" : ""}`),
			]),
		);
		lines.push(
			this.#filtering || this.#filter
				? ` ${t.fg("accent", "/")} ${this.#filter}${this.#filtering ? t.fg("accent", "▏") : ""}`
				: ` ${t.fg("dim", "/ filter by callsign or directory")}`,
		);
		const side = width >= 110 ? Math.min(48, Math.floor(width * 0.34)) : 0;
		const listWidth = width - (side > 0 ? side + 1 : 0);
		const bodyRows = rows - lines.length - 1;
		const left = this.#listColumn(listWidth, bodyRows);
		const right = side > 0 ? this.#detailColumn(side, bodyRows) : [];
		for (let row = 0; row < bodyRows; row += 1) {
			const l = fit(left[row] ?? "", listWidth);
			lines.push(side > 0 ? `${l}${t.fg("border", "│")}${fit(right[row] ?? "", side)}` : l);
		}
		lines.push(
			this.#footer(width, [
				["↑↓", "select"],
				["enter", "thread"],
				["/", "filter"],
				["c", "contacts only"],
				["g", "go to pane"],
				["y", "copy"],
				["r", "rename me"],
				["esc", "close"],
			]),
		);
		return lines;
	}

	#listColumn(width: number, height: number): string[] {
		const t = this.#theme;
		const visible = this.#visible();
		if (this.#selected >= visible.length) this.#selected = Math.max(0, visible.length - 1);
		const nameW = Math.min(24, Math.max(14, ...visible.map(e => e.callsign.length)));
		const stateW = 10;
		const viaW = 4;
		const whereW = 12;
		const seenW = 5;
		const dirW = Math.max(8, width - 2 - nameW - stateW - viaW - whereW - seenW - 7);
		const cells = (mark: string, name: string, state: string, dir: string, via: string, where: string, seen: string): string =>
			` ${fit(mark, 1)} ${fit(name, nameW)} ${fit(state, stateW)} ${fit(dir, dirW)} ${fit(via, viaW)} ${fit(where, whereW)} ${fit(seen, seenW)}`;
		const out: string[] = [t.fg("muted", cells(" ", "callsign", "state", "directory", "via", "where", "seen"))];
		if (visible.length === 0) {
			out.push("");
			out.push(t.fg("muted", this.#filter || this.#contactsOnly ? "  nothing matches" : "  no other sessions in this collective"));
			return out;
		}
		// Section rows interleave with entries; keep the selected entry inside the window.
		type Row = { kind: "section"; text: string } | { kind: "entry"; entry: Entry; index: number };
		const rowsList: Row[] = [];
		let section = "";
		visible.forEach((entry, index) => {
			const next = entry.contact ? "contacts" : entry.state === "offline" ? "offline · reserved for their sessions" : "others";
			if (next !== section) {
				rowsList.push({ kind: "section", text: next });
				section = next;
			}
			rowsList.push({ kind: "entry", entry, index });
		});
		const room = height - out.length;
		const selectedRow = rowsList.findIndex(row => row.kind === "entry" && row.index === this.#selected);
		if (selectedRow < this.#scroll) this.#scroll = Math.max(0, selectedRow - 1);
		if (selectedRow >= this.#scroll + room) this.#scroll = selectedRow - room + 1;
		this.#scroll = Math.max(0, Math.min(this.#scroll, Math.max(0, rowsList.length - room)));
		for (const row of rowsList.slice(this.#scroll, this.#scroll + room)) {
			if (row.kind === "section") {
				out.push(t.fg("dim", `  ${row.text}`));
				continue;
			}
			const { entry } = row;
			const off = entry.state === "offline";
			const text = cells(
				entry.contact ? t.fg("warning", "★") : " ",
				entry.callsign,
				this.#stateCell(entry),
				shortDir(entry.cwd),
				entry.via ?? "",
				off ? "—" : whereLabel(entry),
				this.#seen(entry),
			);
			const shown = off ? t.fg("dim", text) : text;
			out.push(row.index === this.#selected ? t.bg("selectedBg", fit(shown, width)) : shown);
		}
		return out;
	}

	#detailColumn(width: number, height: number): string[] {
		const t = this.#theme;
		const entry = this.#current();
		const out: string[] = [];
		if (!entry) return out;
		const inner = width - 2;
		out.push(` ${t.bold(t.fg("accent", entry.callsign))}${entry.contact ? t.fg("muted", " · contact") : ""}`);
		out.push("");
		const kv = (key: string, value: string): void => {
			out.push(` ${t.fg("muted", fit(key, 10))}${fit(value, inner - 10)}`);
		};
		kv("directory", entry.cwd ? shortDir(entry.cwd) : "—");
		kv("harness", [entry.via, entry.model].filter(Boolean).join(" · ") || "—");
		if (entry.state === "working") kv("state", t.fg("accent", entry.busySince ? `working, ${formatAgo(Date.now() - entry.busySince)} into a turn` : "working"));
		else if (entry.state === "offline") kv("state", t.fg("dim", `offline, last ran ${formatAgo(Date.now() - (entry.lastRanAt ?? Date.now()))} ago`));
		else if (entry.state === "quiet") kv("state", t.fg("warning", "no presence update for 5+ min — may be suspended"));
		else kv("state", t.fg("success", "idle"));
		if (entry.where?.tern) kv("where", `Tern pane ${entry.where.tern.pane}`);
		else if (entry.where?.herdr) kv("where", `herdr pane ${entry.where.herdr.pane}`);
		else if (entry.where?.tty) kv("where", `terminal ${entry.where.tty}`);
		if (entry.pid !== undefined) kv("pid", String(entry.pid));
		if (entry.sessionId) kv("session", entry.sessionId.length > 14 ? `${entry.sessionId.slice(0, 8)}…${entry.sessionId.slice(-4)}` : entry.sessionId);
		if (entry.record) kv("running", formatAgo(Date.now() - entry.record.startedAt));
		const last = this.#api.thread(entry.callsign).at(-1);
		if (last) {
			out.push("");
			out.push(` ${t.fg("muted", `last message · ${clock(last.at)}`)}`);
			const who = last.dir === "out" ? `you → ${entry.callsign}` : `${entry.callsign} → you`;
			out.push(` ${who}${last.outcome ? ` ${this.#outcomeTag(last.outcome)}` : ""}`);
			for (const line of wrap(last.body, inner).slice(0, 3)) out.push(` ${t.fg("muted", line)}`);
		}
		out.push("");
		out.push(` ${t.bold("enter")} ${t.fg("muted", "thread & message")}`);
		if (entry.where?.tern || entry.where?.herdr) out.push(` ${t.bold("g")} ${t.fg("muted", `go to ${entry.where.tern ? "Tern" : "herdr"} pane`)}`);
		out.push(` ${t.bold("y")} ${t.fg("muted", "copy callsign")}`);
		return out.slice(0, height);
	}

	#outcomeTag(outcome: string): string {
		const t = this.#theme;
		const tone =
			outcome === "woken" || outcome === "injected" ? "success"
			: outcome === "aside" || outcome === "steered" || outcome === "coalesced" ? "accent"
			: outcome === "offline" ? "warning"
			: "error";
		return t.fg(tone, `[${outcome}]`);
	}

	#renderThread(width: number, rows: number): string[] {
		const t = this.#theme;
		const peer = this.#peer ?? "";
		const entry = this.#entries.find(e => e.callsign === peer);
		const lines: string[] = [];
		lines.push(
			this.#header(width, [
				t.bold(t.fg("accent", "‹ collective")),
				`you ${t.fg("dim", "⇄")} ${t.fg("accent", peer)}`,
				entry ? this.#stateCell(entry) : t.fg("dim", "– gone"),
				t.fg("muted", entry ? [entry.via, shortDir(entry.cwd), entry.state === "offline" ? "" : whereLabel(entry)].filter(Boolean).join(" · ") : ""),
			]),
		);
		const composerLines = wrap(this.#draft, width - 4);
		const composerRows = Math.min(6, composerLines.length);
		const logRows = rows - lines.length - composerRows - 3;
		const body: string[] = [];
		const whoW = Math.min(36, Math.max(20, peer.length + 18));
		const textW = Math.max(20, width - whoW - 9);
		if (this.#messages.length === 0) body.push(t.fg("muted", "  no messages with this session yet"));
		for (const message of this.#messages) {
			const who = message.dir === "out" ? `you → ${peer}` : `${message.human ? message.peer : peer} → you`;
			const tag = message.dir === "out" && message.outcome ? this.#outcomeTag(message.outcome) : t.fg("dim", `hop ${message.hop}`);
			const wrapped = wrap(message.body, textW);
			const dim = message.outcome === "refused" || message.outcome === "failed" || message.outcome === "offline";
			wrapped.forEach((line, index) => {
				const head = index === 0 ? `  ${t.fg("muted", clock(message.at))}  ${fit(`${who} ${tag}`, whoW)} ` : `  ${" ".repeat(5)}  ${" ".repeat(whoW)} `;
				body.push(head + (dim ? t.fg("dim", line) : line));
			});
			body.push("");
		}
		const shown = body.slice(Math.max(0, body.length - logRows));
		for (let i = 0; i < logRows; i += 1) lines.push(shown[i] ?? "");
		lines.push(t.fg("border", "─".repeat(width)));
		const visibleComposer = composerLines.slice(-composerRows);
		visibleComposer.forEach((line, index) => {
			const prompt = index === 0 ? t.fg("accent", "› ") : "  ";
			const cursor = index === visibleComposer.length - 1 ? t.fg("accent", this.#sending ? "…" : "▏") : "";
			lines.push(` ${prompt}${line}${cursor}`);
		});
		if (this.#draft === "") lines[lines.length - 1] = ` ${t.fg("accent", "›")} ${t.fg("dim", `message ${peer}`)}${t.fg("accent", "▏")}`;
		lines.push(
			this.#footer(width, [
				["enter", `send as ${this.#api.callsign()} (hop 0)`],
				["shift+enter", "new line"],
				["ctrl+g", "go to pane"],
				["esc", "back"],
			]),
		);
		return lines;
	}

	#overlayRename(lines: string[], width: number, rows: number): void {
		const t = this.#theme;
		const boxW = Math.min(72, width - 4);
		const inner = boxW - 4;
		const typed = this.#renameText.trim();
		const current = this.#api.callsign();
		const preview = typed ? this.#api.previewName(typed) : undefined;
		const body: string[] = [
			t.bold(t.fg("accent", "Callsign for this session")),
			"",
			`${typed}${t.fg("accent", "▏")}`,
			"",
			!typed
				? t.fg("muted", "empty: back to the session name, else an automatic <dir>-NNN")
				: typed === current
					? t.fg("muted", "unchanged")
					: preview?.held
						? `${t.fg("warning", `${typed} is held by a running session`)} → this one would be ${typed}-002 or the next free number`
						: `${current} ${t.fg("dim", "→")} ${t.fg("accent", typed)}  ${t.fg("success", "free")}`,
			t.fg("muted", `Saved for this session. ${current} is freed now, not reserved.`),
			"",
			`${t.bold("enter")} ${t.fg("muted", "rename")}  ${t.bold("ctrl+u")} ${t.fg("muted", "clear override")}  ${t.bold("esc")} ${t.fg("muted", "cancel")}`,
		];
		const top = Math.max(1, Math.floor((rows - body.length - 2) / 2));
		const leftPad = Math.max(0, Math.floor((width - boxW) / 2));
		const frame = (text: string): string => `${" ".repeat(leftPad)}${t.fg("accent", "│")} ${fit(text, inner)} ${t.fg("accent", "│")}`;
		lines[top] = `${" ".repeat(leftPad)}${t.fg("accent", `┌${"─".repeat(boxW - 2)}┐`)}`;
		body.forEach((text, index) => {
			lines[top + 1 + index] = frame(text);
		});
		lines[top + 1 + body.length] = `${" ".repeat(leftPad)}${t.fg("accent", `└${"─".repeat(boxW - 2)}┘`)}`;
	}
}

/** Open the full-screen /collective overlay; resolves when it closes. */
export async function openCollectiveTui(custom: CustomUi, api: CollectiveTuiApi): Promise<void> {
	await custom<void>(
		(tui, theme, _keybindings, done) => new CollectiveView(api, tui, theme, () => done(undefined)),
		{ overlay: true, overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%", margin: 0 } },
	);
}
