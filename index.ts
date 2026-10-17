/**
 * collective — peer messaging between omp and pi instances on one machine.
 *
 * Every agent process writes one presence record into its collective's directory and
 * listens on its own unix socket. Three rules shape everything below:
 *
 *   - **Scoped.** A collective is one omp profile (`OMP_PROFILE` / `PI_PROFILE`, or
 *     `default`). Instances in different profiles never see each other.
 *   - **Silent.** Presence is pulled, never pushed: nothing polls the directory, nothing
 *     announces joins or leaves, nothing is injected into prompts. A session learns who
 *     else is live only when a tool asks (`peers`, `peer_send`).
 *   - **Need-to-know.** A session's contacts are the peers it has messaged or heard from.
 *     Only those are shown in its status chip, and they persist per session.
 *
 * omp and pi expose the same two tools. Inbound messages arrive through
 * `sendUserMessage`: an idle agent wakes; a busy omp agent receives an aside (no tool-batch
 * interrupt), a busy pi agent a steer (pi has no aside).
 *
 * Two host quirks worth knowing before editing this file:
 *   - NEVER detach a method from the api object (`const on = pi.on`). omp's ExtensionAPI
 *     methods are class methods that need `this`; pi's are closures. Detaching works on
 *     pi and throws `undefined is not an object (evaluating 'this.extension')` on omp.
 *   - The host rewrites its own package specifiers with an `onResolve` hook scoped to the
 *     extension's load pass, so only *literal* specifiers resolve in dynamic imports.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/** Presence record layout. 0.3.x wrote v1 records to the root directory; they are ignored. */
const RECORD_VERSION = 2;
/** How often an instance checks that its socket is still reachable at its path. */
const CHECK_MS = 5_000;
/** Record refresh cadence, in checks (~1 min). Only used to show how recent a record is. */
const REFRESH_CHECKS = 12;
/** A record not refreshed this long is shown as possibly unreachable; it is never deleted. */
const QUIET_MS = 5 * 60_000;
/** How long a sender waits for a live peer to re-bind a lost socket before giving up. */
const HEAL_WAIT_MS = CHECK_MS + 2_000;
const PEER_TIMEOUT_MS = 8_000;
const MAX_CALLSIGN = 24;
/** An unreadable claim younger than this is mid-write, not corrupt. */
const CLAIM_WRITE_GRACE_MS = 10_000;
/**
 * How long a callsign stays reserved for its session after that session last ran. Within
 * it, nobody else is given the name and a resume takes it back; after it, the name is free.
 */
const RESERVE_MS = 7 * 24 * 60 * 60_000;
const MAX_STATUS_NAME = 12;
const MAX_STATUS_WIDTH = 32;
/**
 * How far a chain of agent-to-agent messages may travel from the human prompt that started
 * it. Each hop costs a real turn in a terminal nobody is watching, so the ceiling is low:
 * enough for a question, an answer, and an acknowledgement, not enough for a runaway.
 */
const MAX_HOPS = 4;
/** Burst window: messages from one peer arriving inside it become a single wake. */
const COALESCE_MS = 400;

/**
 * Root of every collective. Deliberately not derived from any agent-dir env var: omp and pi
 * must land in the same place when they share a profile.
 */
const COLLECTIVE_ROOT = path.join(os.homedir(), ".agent-collective");

/**
 * The collective this process belongs to. omp exports the active profile into both env
 * vars when started with `--profile`; pi has no profiles, so it is always `default`.
 */
function resolveScope(): string {
	const raw = (process.env.OMP_PROFILE ?? process.env.PI_PROFILE ?? "").trim();
	return /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(raw) && !raw.endsWith(".") ? raw : "default";
}

interface PeerRecord {
	v: number;
	pid: number;
	callsign: string;
	cwd: string;
	project: string;
	via: "omp" | "pi";
	sessionId?: string;
	model?: string;
	socket: string;
	startedAt: number;
	/** Last time the owner rewrote the record; display only. */
	beatAt: number;
	busy: boolean;
}

/**
 * Frame exchanged over a peer's unix socket, one JSON object per line.
 *
 * `hop` is the message's distance from a human prompt: 0 for a message an agent sends on
 * its own initiative, otherwise one more than the message it answers. It exists because
 * mutual wake is a *behavioural* loop, not a transport loop — A wakes B, B's resulting turn
 * wakes A, and every individual delivery is a legitimate single hop, so no transport-level
 * guard ever trips. Absent is treated as 0.
 */
type PeerFrame =
	| { t: "msg"; from: string; body: string; replyTo?: string; hop?: number }
	| { t: "ping"; from: string };

interface PeerReply {
	ok: boolean;
	outcome?: string;
	callsign?: string;
	error?: string;
	/** Set locally when the connection itself failed (`ENOENT`, `ECONNREFUSED`, ...). */
	transport?: string;
}

interface CollectiveContext {
	cwd: string;
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		setStatus(key: string, text: string | undefined): void;
	};
	isIdle(): boolean;
	sessionManager: {
		getSessionId(): string | undefined;
		/** omp's header carries `titleSource`; pi's does not, so treat it as optional. */
		getHeader?(): { titleSource?: string } | undefined;
	};
	model?: { id?: string };
	/** omp only: managed timers that contain a throwing callback. pi has no equivalent. */
	setInterval?(callback: () => void, ms?: number): unknown;
	clearTimer?(timer: unknown): void;
}

interface ToolResult {
	content: { type: "text"; text: string }[];
	details?: unknown;
}

interface CollectivePi {
	on(event: string, handler: (event: unknown, ctx: CollectiveContext) => Promise<void> | void): void;
	registerCommand(
		name: string,
		options: { description?: string; handler: (args: string, ctx: CollectiveContext) => Promise<void> },
	): void;
	registerTool(tool: {
		name: string;
		label: string;
		description: string;
		parameters: unknown;
		execute: (
			toolCallId: string,
			params: Record<string, unknown>,
			signal?: AbortSignal,
		) => Promise<ToolResult>;
	}): void;
	getSessionName(): string | undefined;
	/** omp has `"aside"` (no interrupt mid-turn); pi does not. */
	sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" | "aside" }): void;
	logger?: { warn(message: string): void };
}

/** One collective node per process, even when several sessions load the extension. */
let node: CollectiveNode | undefined;

/**
 * Get the live node, starting one if this process has none. Every entry point re-arms,
 * so a module loaded after the session began, or a session replaced in-process, still
 * gets a node as soon as anything asks for one.
 */
function ensureNode(pi: CollectivePi, ctx: CollectiveContext): CollectiveNode | undefined {
	if (node && !node.stopped) return node;
	try {
		const started = new CollectiveNode(pi, ctx);
		started.start();
		node = started;
		return node;
	} catch (error) {
		node = undefined;
		pi.logger?.warn(`collective: could not start (${String(error)})`);
		ctx.ui.notify(`collective: could not start — ${error instanceof Error ? error.message : String(error)}`, "warning");
		return undefined;
	}
}

/** True while `pid` exists. EPERM means it exists under another user, which still counts. */
function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * The OS start time of `pid`. With the pid it identifies one process, so a claim left by a
 * crashed session is not mistaken for live when its pid has been reused. Undefined when `ps`
 * is unavailable; callers then fall back to the pid alone.
 */
function processStart(pid: number): string | undefined {
	try {
		const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
			encoding: "utf8",
			env: { ...process.env, LC_ALL: "C" },
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return out.length > 0 ? out : undefined;
	} catch {
		return undefined;
	}
}

/** Contents of `names/<callsign>`: which process holds that callsign. */
interface NameClaim {
	pid: number;
	start?: string;
	sessionId?: string;
}

/** A claim file's owner, `"missing"`, or `"unreadable"` (mid-write, or left corrupt by a crash). */
function readClaim(file: string): NameClaim | "missing" | "unreadable" {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return "missing";
	}
	try {
		const claim = JSON.parse(text) as NameClaim;
		return typeof claim.pid === "number" ? claim : "unreadable";
	} catch {
		return "unreadable";
	}
}

/**
 * Prefix of automatic callsigns: `<dir>-001`, `<dir>-002`, … Every session in a collective
 * shares its profile, so the working directory is what tells sessions apart at a glance.
 */
function autoPrefix(cwd: string): string {
	const base = path
		.basename(cwd)
		.replace(/[^\w.-]+/gu, "-")
		.replace(/^[^A-Za-z0-9_]+/u, "")
		.slice(0, 20);
	return base.length > 0 ? base : "session";
}

/** Per-session state that survives restart and resume. */
interface SessionState {
	callsign?: string;
	override?: string;
	contacts?: string[];
}

class CollectiveNode {
	readonly #pi: CollectivePi;
	readonly #ctx: CollectiveContext;
	readonly scope = resolveScope();
	readonly #dir = path.join(COLLECTIVE_ROOT, this.scope);
	readonly #socketPath = path.join(this.#dir, `${process.pid}.sock`);
	readonly #recordPath = path.join(this.#dir, `${process.pid}.json`);
	readonly #startedAt = Date.now();
	/** omp hands extensions managed timers on the context; pi does not. */
	readonly #via: "omp" | "pi";
	/** Bodies accumulating inside the current burst window, keyed by sender. */
	readonly #pending = new Map<string, { bodies: string[]; hop: number }>();
	/**
	 * Hop of the peer message that woke the current turn; undefined when the turn was started
	 * by a human (or no turn is running). Every send a woken turn makes is at least one past it,
	 * which is what bounds a loop of agents waking each other.
	 */
	#turnHop: number | undefined;
	/**
	 * Highest hop received from each peer during the current turn. A send to that peer is
	 * treated as an answer to it. Sends to anyone else are not — a message that steers into a
	 * running turn must not tax that turn's unrelated traffic.
	 */
	readonly #peerHops = new Map<string, number>();
	/** Peers this session has messaged or heard from; the only peers it surfaces unprompted. */
	readonly #contacts = new Set<string>();
	/** `names/<callsign>` claim files: one file per held callsign, created exclusively. */
	readonly #namesDir = path.join(this.#dir, "names");
	readonly #sessionId: string | undefined;
	/** `sessions/<session-id>.json`; undefined when the host reports no usable session id. */
	readonly #statePath: string | undefined;
	readonly #processStart = processStart(process.pid);
	/** Callsign restored from this session's state, reclaimed first so a resumed session keeps its address. */
	#remembered: string | undefined;
	#override: string | undefined;
	#callsign = "";
	/** What the last allocation asked for ("" = automatic), so a `/rename` is noticed. */
	#allocatedFor: string | undefined;
	#busy = false;
	#server: net.Server | undefined;
	/** Inode of the socket file this process bound; anything else at the path is not ours. */
	#socketIno: number | undefined;
	#binding = false;
	#binds = 0;
	#checks = 0;
	#stopTimer: (() => void) | undefined;
	#stopped = false;

	constructor(pi: CollectivePi, ctx: CollectiveContext) {
		this.#pi = pi;
		this.#ctx = ctx;
		this.#via = ctx.setInterval && ctx.clearTimer ? "omp" : "pi";
		const sessionId = ctx.sessionManager.getSessionId();
		this.#sessionId = sessionId && /^[\w.-]+$/u.test(sessionId) ? sessionId : undefined;
		this.#statePath = this.#sessionId ? path.join(this.#dir, "sessions", `${this.#sessionId}.json`) : undefined;
	}

	get callsign(): string {
		return this.#callsign;
	}

	get stopped(): boolean {
		return this.#stopped;
	}

	get contacts(): ReadonlySet<string> {
		return this.#contacts;
	}

	start(): void {
		fs.mkdirSync(this.#namesDir, { recursive: true, mode: 0o700 });
		this.#loadState();
		this.#bind();
		this.#allocate();
		this.#writeRecord();
		this.#renderStatus();
		if (this.#ctx.setInterval && this.#ctx.clearTimer) {
			// omp: the managed timer contains a throwing callback and is cleared on shutdown.
			const timer = this.#ctx.setInterval(() => this.#check(), CHECK_MS);
			this.#stopTimer = () => this.#ctx.clearTimer?.(timer);
		} else {
			// pi: no managed timers, so this callback owns its guard — an escaping throw
			// from a raw interval surfaces as a process-fatal uncaughtException.
			const timer = setInterval(() => {
				try {
					this.#check();
				} catch (error) {
					this.#pi.logger?.warn(`collective: check failed: ${String(error)}`);
				}
			}, CHECK_MS);
			timer.unref?.();
			this.#stopTimer = () => clearInterval(timer);
		}
	}

	stop(): void {
		if (this.#stopped) return;
		this.#stopped = true;
		this.#stopTimer?.();
		this.#server?.close();
		if (this.#ownsSocket()) fs.rmSync(this.#socketPath, { force: true });
		fs.rmSync(this.#recordPath, { force: true });
		// The callsign stays reserved for this session: stamp the claim with the exit time, which
		// is when the reservation clock starts.
		this.#touchClaim();
		this.#ctx.ui.setStatus("collective", undefined);
	}

	/** `/callsign`: remembered for this session, so it survives restart and resume. */
	setOverride(name: string): string {
		this.#override = name.length > 0 ? name : undefined;
		if (this.#allocate()) this.#writeRecord();
		this.#saveState();
		return this.#callsign;
	}

	/** Turn boundaries are the only time busy state changes, so they are the only writes. */
	setBusy(busy: boolean): void {
		if (this.#busy === busy) return;
		this.#busy = busy;
		this.#writeRecord();
	}

	/**
	 * Periodic self-check, touching only this process's own files: re-binds the socket when
	 * its file is gone or replaced; re-allocates the callsign after a `/rename`, or if the
	 * claim file no longer names this process; and refreshes the record about once a minute
	 * so `peers` can say how recent it is.
	 */
	#check(): void {
		if (this.#stopped) return;
		this.#checks += 1;
		const owner = readClaim(path.join(this.#namesDir, this.#callsign));
		const displaced = typeof owner !== "object" || owner.pid !== process.pid;
		const renamed = ((this.#wantedName() ?? "") !== this.#allocatedFor || displaced) && this.#allocate();
		const healed = !this.#ownsSocket() && this.#bind();
		const recordMissing = !fs.existsSync(this.#recordPath);
		if (renamed || healed || recordMissing || this.#checks % REFRESH_CHECKS === 0) {
			this.#writeRecord();
			this.#touchClaim();
		}
	}

	/** True when the socket file at our path is the one this process bound. */
	#ownsSocket(): boolean {
		if (this.#socketIno === undefined) return this.#binding;
		try {
			return fs.statSync(this.#socketPath).ino === this.#socketIno;
		} catch {
			return false;
		}
	}

	/**
	 * Listen on a fresh temporary path, then rename it over the public one. The rename is
	 * atomic, so a peer never sees a half-bound path; and closing the previous server
	 * afterwards unlinks only that server's own (already renamed-away) path, never the
	 * new socket. Returns false when a bind is already in flight.
	 */
	#bind(): boolean {
		if (this.#binding || this.#stopped) return false;
		this.#binding = true;
		fs.mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
		this.#binds += 1;
		const temporary = path.join(this.#dir, `${process.pid}.${this.#binds}.tmp`);
		fs.rmSync(temporary, { force: true });
		const server = net.createServer(socket => this.#accept(socket));
		server.on("error", error => {
			this.#binding = false;
			this.#pi.logger?.warn(`collective: server error: ${String(error)}`);
		});
		server.listen(temporary, () => {
			this.#binding = false;
			if (this.#stopped) {
				server.close();
				return;
			}
			try {
				fs.chmodSync(temporary, 0o600);
				fs.renameSync(temporary, this.#socketPath);
				this.#socketIno = fs.statSync(this.#socketPath).ino;
			} catch (error) {
				this.#pi.logger?.warn(`collective: could not publish socket: ${String(error)}`);
				server.close();
				return;
			}
			const previous = this.#server;
			this.#server = server;
			previous?.close();
		});
		server.unref();
		return true;
	}

	#writeRecord(): void {
		if (this.#stopped) return;
		const project = path.basename(this.#ctx.cwd);
		const record: PeerRecord = {
			v: RECORD_VERSION,
			pid: process.pid,
			callsign: this.#callsign,
			cwd: this.#ctx.cwd,
			project,
			via: this.#via,
			sessionId: this.#ctx.sessionManager.getSessionId(),
			model: this.#ctx.model?.id,
			socket: this.#socketPath,
			startedAt: this.#startedAt,
			beatAt: Date.now(),
			busy: this.#busy,
		};
		fs.mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
		const temporary = `${this.#recordPath}.tmp`;
		fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
		fs.renameSync(temporary, this.#recordPath);
	}

	/**
	 * The callsign this session asks for by name, or undefined for an automatic one.
	 *
	 * `/callsign` always wins. A session name is adopted only when the host reports the
	 * title as user-set (omp's `titleSource`), because an auto-generated title is a
	 * model-written sentence that `title.refreshOnReplan` rewrites mid-session — adopting
	 * it would rename the session and break every peer's addressing. pi reports no title
	 * source, so there the name is adopted only when it already looks like an address:
	 * one token, no whitespace, within the length cap.
	 */
	#wantedName(): string | undefined {
		const source = this.#ctx.sessionManager.getHeader?.()?.titleSource;
		const sessionName = this.#pi.getSessionName();
		const adoptable =
			source === "user" ||
			(source === undefined && sessionName !== undefined && /^[\w.-]{1,24}$/u.test(sessionName.trim()));
		const cleaned = (this.#override ?? (adoptable ? sessionName : undefined) ?? "")
			.trim()
			.replace(/\s+/gu, "-")
			.replace(/[^\w.-]/gu, "")
			.slice(0, MAX_CALLSIGN);
		// A leading word character keeps `.`, `..` and the claim directory's own dot-files out.
		return /^\w/u.test(cleaned) ? cleaned : undefined;
	}

	/**
	 * Settle this session's callsign, returning true when it changed.
	 *
	 * A named session takes exactly its name, or `<name>-002`, `<name>-003`, … when a live
	 * session already holds it. An unnamed session takes back the callsign it had before a
	 * restart if that is free, else the lowest free `<dir>-NNN`. Every candidate goes through
	 * an exclusive claim, so two sessions can never hold the same callsign.
	 */
	#allocate(): boolean {
		const wanted = this.#wantedName();
		this.#allocatedFor = wanted ?? "";
		const previous = this.#callsign;
		// A suffixed callsign this session already holds, or held before a restart, is kept
		// rather than moving it to a new number.
		const ownNumbered = (prefix: string): string | undefined =>
			[previous, this.#remembered].find(
				name => name !== undefined && name.startsWith(`${prefix}-`) && /^\d{3,}$/u.test(name.slice(prefix.length + 1)) && this.#claim(name),
			);
		let next: string;
		if (wanted !== undefined) {
			const kept = this.#claim(wanted) ? wanted : ownNumbered(wanted);
			next = kept ?? this.#claimNumbered(wanted, 2);
			if (kept === undefined) {
				this.#ctx.ui.notify(`collective: "${wanted}" is held by another session; this one is ${next}`, "warning");
			}
		} else {
			const prefix = autoPrefix(this.#ctx.cwd);
			next = ownNumbered(prefix) ?? this.#claimNumbered(prefix, 1);
		}
		if (previous !== "" && previous !== next) this.#release(previous);
		this.#callsign = next;
		this.#remembered = next;
		if (previous !== next) this.#saveState();
		return previous !== next;
	}

	/** The lowest `<prefix>-NNN` (from `first`) that is neither held nor reserved, claimed by this process. */
	#claimNumbered(prefix: string, first: number): string {
		for (let attempt = 0; attempt < 50; attempt += 1) {
			const taken = new Set<number>();
			let entries: string[] = [];
			try {
				entries = fs.readdirSync(this.#namesDir);
			} catch {
				// No claims yet.
			}
			for (const entry of entries) {
				const suffix = entry.startsWith(`${prefix}-`) ? entry.slice(prefix.length + 1) : "";
				if (/^\d{3,}$/u.test(suffix) && this.#blocked(path.join(this.#namesDir, entry), false)) taken.add(Number(suffix));
			}
			let number = first;
			while (taken.has(number)) number += 1;
			const name = `${prefix}-${String(number).padStart(3, "0")}`;
			if (this.#claim(name)) return name;
		}
		throw new Error(`could not claim a callsign starting with "${prefix}"`);
	}

	/** True when `names/<name>` currently names this process. */
	#holds(name: string): boolean {
		const owner = readClaim(path.join(this.#namesDir, name));
		return typeof owner === "object" && owner.pid === process.pid;
	}

	/**
	 * True when the claim at `file` keeps this process from taking it: it is mid-write, its
	 * process is running, or it is still reserved for a different session. `exact` verifies a
	 * running pid by start time (one `ps`); the number scan skips that and lets `#claim` decide.
	 */
	#blocked(file: string, exact: boolean): boolean {
		const owner = readClaim(file);
		if (owner === "missing") return false;
		let age: number;
		try {
			age = Date.now() - fs.statSync(file).mtimeMs;
		} catch {
			return false;
		}
		if (owner === "unreadable") return age < CLAIM_WRITE_GRACE_MS;
		if (owner.pid === process.pid) return false;
		if (exact ? this.#claimLive(owner) : pidAlive(owner.pid)) return true;
		return owner.sessionId !== undefined && owner.sessionId !== this.#sessionId && age < RESERVE_MS;
	}

	/**
	 * Take `names/<name>` for this process, or report it unavailable. The create is exclusive
	 * (`wx`), which is the whole collision guarantee. A claim that no longer blocks — its
	 * process is gone and its reservation expired, or it is this session's own — is taken over
	 * by renaming it aside first: rename is atomic, so of several sessions racing for the same
	 * name exactly one moves it, and the rest fall back to the exclusive create.
	 */
	#claim(name: string): boolean {
		const file = path.join(this.#namesDir, name);
		const mine: NameClaim = { pid: process.pid, start: this.#processStart, sessionId: this.#sessionId };
		for (let attempt = 0; attempt < 4; attempt += 1) {
			try {
				fs.writeFileSync(file, JSON.stringify(mine), { flag: "wx", mode: 0o600 });
				return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			if (this.#holds(name)) return true;
			if (this.#blocked(file, true)) return false;
			const aside = path.join(this.#namesDir, `.stale-${process.pid}-${Date.now()}-${attempt}`);
			try {
				fs.renameSync(file, aside);
			} catch {
				continue;
			}
			// Between the check and the rename another session may have taken the name; if what
			// moved still blocks, put it back rather than steal it.
			if (this.#blocked(aside, true)) {
				try {
					fs.linkSync(aside, file);
				} catch {
					// Someone created the name meanwhile; the displaced owner re-allocates on its next check.
				}
				fs.rmSync(aside, { force: true });
				return false;
			}
			fs.rmSync(aside, { force: true });
		}
		return false;
	}

	/** A claim is live while its pid exists and, when both sides know it, its start time matches. */
	#claimLive(owner: NameClaim): boolean {
		if (!pidAlive(owner.pid)) return false;
		if (owner.start === undefined || this.#processStart === undefined) return true;
		return processStart(owner.pid) === owner.start;
	}

	/** Keep the claim's mtime near "last ran", which is what a reservation expires from. */
	#touchClaim(): void {
		if (!this.#holds(this.#callsign)) return;
		const now = new Date();
		try {
			fs.utimesSync(path.join(this.#namesDir, this.#callsign), now, now);
		} catch {
			// Re-claimed on the next check.
		}
	}

	/** Give up `name` outright (a rename away from it): it is not reserved. */
	#release(name: string): void {
		if (name !== "" && this.#holds(name)) fs.rmSync(path.join(this.#namesDir, name), { force: true });
	}

	/**
	 * Every record in this collective whose process still exists. A dead process's record
	 * and socket are removed; a live process's files are NEVER touched, however stale its
	 * record looks — a laptop sleep or a stalled event loop is not death, and unlinking a
	 * live listener's socket strands it unreachable for good.
	 */
	#readRecords(): PeerRecord[] {
		let names: string[];
		try {
			names = fs.readdirSync(this.#dir);
		} catch {
			return [];
		}
		const records: PeerRecord[] = [];
		for (const name of names) {
			if (!/^\d+\.json$/u.test(name)) continue;
			const file = path.join(this.#dir, name);
			let record: PeerRecord;
			try {
				record = JSON.parse(fs.readFileSync(file, "utf8")) as PeerRecord;
			} catch {
				// Mid-rename or truncated; the owner rewrites it within a minute.
				continue;
			}
			if (record.v !== RECORD_VERSION || typeof record.pid !== "number" || typeof record.callsign !== "string") continue;
			if (record.pid !== process.pid && !pidAlive(record.pid)) {
				fs.rmSync(file, { force: true });
				if (record.socket.startsWith(this.#dir)) fs.rmSync(record.socket, { force: true });
				continue;
			}
			records.push(record);
		}
		return records;
	}

	/** Live peers, contacts first. Read on demand; nothing is cached between calls. */
	listPeers(): { record: PeerRecord; contact: boolean; quiet: boolean }[] {
		const now = Date.now();
		return this.#readRecords()
			.filter(record => record.pid !== process.pid)
			.map(record => ({
				record,
				contact: this.#contacts.has(record.callsign),
				quiet: now - record.beatAt > QUIET_MS,
			}))
			.sort((a, b) =>
				a.contact !== b.contact ? (a.contact ? -1 : 1) : a.record.callsign.localeCompare(b.record.callsign),
			);
	}

	async dispatch(callsign: string, body: string, replyTo?: string): Promise<string> {
		const peers = this.#readRecords().filter(record => record.pid !== process.pid);
		// The claim file is the single source of truth for who holds a callsign; records only
		// carry a copy. Records are matched by name alone for peers on 0.4.0, which wrote no claims.
		const owner = readClaim(path.join(this.#namesDir, callsign));
		const record =
			typeof owner === "object"
				? peers.find(peer => peer.pid === owner.pid)
				: owner === "missing"
					? peers.find(peer => peer.callsign === callsign)
					: undefined;
		if (!record && typeof owner === "object" && owner.sessionId !== undefined) {
			let lastRan: number | undefined;
			try {
				lastRan = fs.statSync(path.join(this.#namesDir, callsign)).mtimeMs;
			} catch {
				lastRan = undefined;
			}
			if (lastRan !== undefined && Date.now() - lastRan < RESERVE_MS) {
				const minutes = Math.max(1, Math.round((Date.now() - lastRan) / 60_000));
				const ago = minutes < 60 ? `${minutes} min` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / 1440)} days`;
				return `${callsign} is offline (its session last ran ${ago} ago). The callsign stays reserved for that session until it resumes or for ${RESERVE_MS / 86_400_000} days, so nothing else received this message.`;
			}
		}
		if (!record) {
			const needle = callsign.toLowerCase();
			const close = peers.map(peer => peer.callsign).filter(name => name.toLowerCase().includes(needle));
			return `Unknown peer "${callsign}" in collective "${this.scope}".${close.length > 0 ? ` Did you mean: ${close.join(", ")}?` : " Use the peers tool to list live sessions."}`;
		}
		const reply = await this.#send(record, {
			t: "msg",
			from: this.#callsign,
			body,
			replyTo,
			hop: this.#outboundHop(callsign),
		});
		if (!reply.ok) return `Delivery to ${callsign} failed: ${reply.error ?? "unknown error"}`;
		this.#addContact(callsign);
		return `Delivered to ${callsign} (${reply.outcome ?? "injected"}). Its reply will arrive as a peer message.`;
	}

	/**
	 * Deliver one frame. A live peer whose socket is missing or refusing is re-binding (or
	 * will be within one check period), so wait for its socket to come back and retry once
	 * rather than reporting a dead peer.
	 */
	async #send(record: PeerRecord, frame: PeerFrame): Promise<PeerReply> {
		const first = await this.#request(record.socket, frame);
		if (first.transport !== "ENOENT" && first.transport !== "ECONNREFUSED") return first;
		if (!pidAlive(record.pid)) return { ok: false, error: `${record.callsign} has exited` };
		const deadline = Date.now() + HEAL_WAIT_MS;
		let before: number | undefined;
		try {
			before = fs.statSync(record.socket).ino;
		} catch {
			before = undefined;
		}
		while (Date.now() < deadline) {
			await new Promise(resolve => setTimeout(resolve, 250));
			let now: number | undefined;
			try {
				now = fs.statSync(record.socket).ino;
			} catch {
				now = undefined;
			}
			if (now !== undefined && now !== before) return this.#request(record.socket, frame);
		}
		return {
			ok: false,
			error: `${record.callsign} is running but its socket did not come back within ${HEAL_WAIT_MS / 1000} s (it may be suspended, or on agent-collective older than 0.4)`,
		};
	}

	/** One request/response round trip over a peer's socket. */
	#request(socketPath: string, frame: PeerFrame): Promise<PeerReply> {
		const { promise, resolve } = Promise.withResolvers<PeerReply>();
		let settled = false;
		const socket = net.createConnection({ path: socketPath });
		const finish = (value: PeerReply): void => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(value);
		};
		socket.setTimeout(PEER_TIMEOUT_MS, () => finish({ ok: false, error: "timeout" }));
		socket.on("error", error =>
			finish({ ok: false, error: String(error), transport: (error as NodeJS.ErrnoException).code }),
		);
		socket.on("connect", () => socket.write(`${JSON.stringify(frame)}\n`));
		let buffer = "";
		socket.on("data", chunk => {
			buffer += String(chunk);
			const line = buffer.indexOf("\n");
			if (line === -1) return;
			try {
				finish(JSON.parse(buffer.slice(0, line)) as PeerReply);
			} catch {
				finish({ ok: false, error: "bad response" });
			}
		});
		socket.on("close", () => finish({ ok: false, error: "socket closed before replying" }));
		return promise;
	}

	#loadState(): void {
		if (!this.#statePath) return;
		let saved: SessionState;
		try {
			saved = JSON.parse(fs.readFileSync(this.#statePath, "utf8")) as SessionState;
		} catch {
			return;
		}
		if (typeof saved.callsign === "string") this.#remembered = saved.callsign;
		if (typeof saved.override === "string") this.#override = saved.override;
		if (Array.isArray(saved.contacts)) for (const name of saved.contacts) if (typeof name === "string") this.#contacts.add(name);
	}

	#saveState(): void {
		if (!this.#statePath) return;
		const state: SessionState = { callsign: this.#callsign, override: this.#override, contacts: [...this.#contacts] };
		try {
			fs.mkdirSync(path.dirname(this.#statePath), { recursive: true, mode: 0o700 });
			fs.writeFileSync(this.#statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
		} catch (error) {
			this.#pi.logger?.warn(`collective: could not save session state: ${String(error)}`);
		}
	}

	#addContact(callsign: string): void {
		if (this.#contacts.has(callsign)) return;
		this.#contacts.add(callsign);
		this.#renderStatus();
		this.#saveState();
	}

	/** Footer chip: this session's contacts only — never the whole collective. */
	#renderStatus(): void {
		if (this.#contacts.size === 0) {
			this.#ctx.ui.setStatus("collective", undefined);
			return;
		}
		const shown: string[] = [];
		let width = 0;
		for (const callsign of [...this.#contacts].sort()) {
			const name = callsign.length > MAX_STATUS_NAME ? `${callsign.slice(0, MAX_STATUS_NAME - 1)}…` : callsign;
			if (shown.length > 0 && width + 1 + name.length > MAX_STATUS_WIDTH) break;
			width += (shown.length > 0 ? 1 : 0) + name.length;
			shown.push(name);
		}
		const hidden = this.#contacts.size - shown.length;
		this.#ctx.ui.setStatus("collective", `⇄ ${shown.join(" ")}${hidden > 0 ? ` +${hidden}` : ""}`);
	}

	/**
	 * Hop count to stamp on a message to `to`: one past the larger of the hop that woke this
	 * turn and the last hop `to` sent during it. A human-started turn writing to a peer that
	 * has not written to it starts a fresh chain at 0.
	 */
	#outboundHop(to: string): number {
		return Math.max(this.#turnHop ?? -1, this.#peerHops.get(to) ?? -1) + 1;
	}

	/**
	 * Record an inbound message's lineage. Only a message that *wakes* the agent roots the
	 * turn; one that steers into a running turn affects replies to its sender alone. Several
	 * wakes landing before the turn starts merge into one turn, so the highest hop roots it.
	 */
	#recordInbound(from: string, hop: number, wakes: boolean): void {
		this.#peerHops.set(from, Math.max(this.#peerHops.get(from) ?? hop, hop));
		if (wakes) this.#turnHop = Math.max(this.#turnHop ?? hop, hop);
	}

	/** A human prompt or the end of a turn ends every chain: the next send starts over. */
	resetLineage(): void {
		this.#turnHop = undefined;
		this.#peerHops.clear();
	}

	#accept(socket: net.Socket): void {
		let buffer = "";
		socket.on("error", () => socket.destroy());
		socket.on("data", chunk => {
			buffer += String(chunk);
			let index = buffer.indexOf("\n");
			while (index !== -1) {
				const line = buffer.slice(0, index);
				buffer = buffer.slice(index + 1);
				index = buffer.indexOf("\n");
				void this.#handle(line, socket);
			}
		});
	}

	async #handle(line: string, socket: net.Socket): Promise<void> {
		let frame: PeerFrame;
		try {
			frame = JSON.parse(line) as PeerFrame;
		} catch {
			socket.write(`${JSON.stringify({ ok: false, error: "bad frame" })}\n`);
			return;
		}
		if (frame.t === "ping") {
			socket.write(`${JSON.stringify({ ok: true, callsign: this.#callsign })}\n`);
			return;
		}
		if (frame.t !== "msg") {
			socket.write(`${JSON.stringify({ ok: false, error: "unknown frame" })}\n`);
			return;
		}
		const hop = typeof frame.hop === "number" && Number.isFinite(frame.hop) ? Math.max(0, Math.trunc(frame.hop)) : 0;
		if (hop > MAX_HOPS) {
			this.#ctx.ui.notify(
				`collective: refused a message from ${frame.from} — hop ${hop} exceeds the ${MAX_HOPS}-hop chain limit`,
				"warning",
			);
			socket.write(
				`${JSON.stringify({
					ok: false,
					error: `Refused: this message is ${hop} hops from a human prompt and the limit is ${MAX_HOPS}. The chain has to end here — do not resend. Ask your user if it must continue.`,
				})}\n`,
			);
			return;
		}
		/**
		 * Coalesce a burst from one peer into a single wake. Each delivery to an idle agent
		 * costs a real turn, so N messages must not mean N turns. The first frame waits out
		 * a short window and then delivers everything that accumulated; later frames in the
		 * window return immediately. An in-flight flag cannot do this job — delivery
		 * resolves inside the same macrotask, so no second frame ever observes it.
		 */
		const pending = this.#pending.get(frame.from);
		if (pending) {
			pending.bodies.push(frame.body);
			pending.hop = Math.min(pending.hop, hop);
			socket.write(`${JSON.stringify({ ok: true, outcome: "coalesced" })}\n`);
			return;
		}
		this.#pending.set(frame.from, { bodies: [frame.body], hop });
		try {
			const { promise, resolve } = Promise.withResolvers<void>();
			const timer = setTimeout(resolve, COALESCE_MS);
			timer.unref?.();
			await promise;
			const batch = this.#pending.get(frame.from) ?? { bodies: [frame.body], hop };
			this.#pending.delete(frame.from);
			const body =
				batch.bodies.length === 1
					? batch.bodies[0]
					: `${batch.bodies.length} messages arrived together:\n\n${batch.bodies.map((entry, index) => `${index + 1}. ${entry}`).join("\n\n")}`;
			const outcome = this.#inject({ from: frame.from, body: body ?? "", replyTo: frame.replyTo, hop: batch.hop });
			socket.write(`${JSON.stringify({ ok: true, outcome })}\n`);
		} catch (error) {
			this.#pending.delete(frame.from);
			socket.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
		}
	}

	/**
	 * Hand an inbound message to the local agent as a prompt. An idle agent wakes into a
	 * turn. A busy omp agent gets an aside, which lands without interrupting the running tool
	 * batch; pi has no aside, so a busy pi agent is steered.
	 */
	#inject(frame: { from: string; body: string; replyTo?: string; hop: number }): "injected" | "woken" {
		const wakes = this.#ctx.isIdle();
		// Any send the resulting turn makes inherits this distance from the human prompt.
		this.#recordInbound(frame.from, frame.hop, wakes);
		this.#addContact(frame.from);
		// Sends a reply to this peer may still make, counting the reply itself.
		const remaining = MAX_HOPS - this.#outboundHop(frame.from) + 1;
		const budget =
			remaining <= 1
				? " This chain is at its last hop, so answer your user rather than relaying further."
				: ` ${remaining} relay hops remain in this chain.`;
		const text = `[collective] message from peer \`${frame.from}\`${frame.replyTo ? " (a reply)" : ""} to you (\`${this.#callsign}\`):\n\n${frame.body}\n\nReply with the \`peer_send\` tool addressed to \`${frame.from}\` if a response is useful.${budget}`;
		if (wakes) this.#pi.sendUserMessage(text);
		else this.#pi.sendUserMessage(text, { deliverAs: this.#via === "omp" ? "aside" : "steer" });
		return wakes ? "woken" : "injected";
	}
}

export default function collective(pi: CollectivePi): void {
	for (const event of ["session_start", "session_switch", "session_branch", "session_tree"]) {
		pi.on(event, async (_payload, ctx) => {
			ensureNode(pi, ctx);
		});
	}

	// A session replaced inside this process (`/new`, `/resume`, `/fork`, `/switch`) tears the
	// node down with its session; the next handler or command re-arms it against the new one.
	pi.on("session_shutdown", async () => {
		node?.stop();
		node = undefined;
	});

	/**
	 * A prompt the human typed starts a fresh chain, so the hop counter resets. Extension
	 * sends are excluded: an inbound peer message arrives that way, and treating it as
	 * human input would zero the counter on every relay and defeat the guard.
	 */
	pi.on("input", async (event, ctx) => {
		const live = ensureNode(pi, ctx);
		const { source } = event as { source?: string };
		if (source === "extension") return;
		live?.resetLineage();
	});

	pi.on("agent_start", async (_event, ctx) => {
		ensureNode(pi, ctx)?.setBusy(true);
	});

	/**
	 * A finished turn owes nothing to the messages it answered, and is the moment the
	 * instance becomes idle — the only other time its record changes.
	 */
	pi.on("agent_end", async () => {
		node?.resetLineage();
		node?.setBusy(false);
	});

	pi.registerCommand("callsign", {
		description: "Show or set this instance's collective callsign",
		handler: async (args, ctx) => {
			const live = ensureNode(pi, ctx);
			if (!live) return;
			const name = args.trim();
			if (name.length === 0) {
				ctx.ui.notify(`collective callsign: ${live.callsign} (collective "${live.scope}")`, "info");
				return;
			}
			ctx.ui.notify(`collective callsign: ${live.setOverride(name)}`, "info");
		},
	});

	pi.registerCommand("collective", {
		description: "List live agent instances in this collective (this omp profile)",
		handler: async (_args, ctx) => {
			const live = ensureNode(pi, ctx);
			if (!live) return;
			const peers = live.listPeers();
			const head = `collective "${live.scope}": you are ${live.callsign}`;
			if (peers.length === 0) {
				ctx.ui.notify(`${head} — no peers`, "info");
				return;
			}
			const lines = peers.map(
				({ record, contact, quiet }) =>
					`${contact ? "★ " : ""}${record.callsign} — ${record.via}, pid ${record.pid} · ${record.cwd}${record.busy ? " · working" : ""}${quiet ? " · quiet" : ""}`,
			);
			ctx.ui.notify(`${head}\n${lines.join("\n")}`, "info");
		},
	});

	pi.registerTool({
		name: "peers",
		label: "Peers",
		description:
			"List the other live agent sessions (omp or pi) in this collective — the sessions on this machine that share your omp profile — with their callsigns. Use it when the user refers to another session (e.g. '@be-audio') and you need its exact callsign, or asks who is online. Sessions you have already talked to are listed first.",
		parameters: {
			type: "object",
			properties: {
				filter: { type: "string", description: "Optional case-insensitive substring of callsign or working directory" },
			},
			additionalProperties: false,
		},
		execute: async (_toolCallId, params) => {
			if (!node || node.stopped) {
				return { content: [{ type: "text", text: "The collective node is not running in this process; run /collective to start it." }] };
			}
			const filter = typeof params.filter === "string" ? params.filter.trim().toLowerCase() : "";
			const peers = node
				.listPeers()
				.filter(
					({ record }) =>
						!filter || record.callsign.toLowerCase().includes(filter) || record.cwd.toLowerCase().includes(filter),
				);
			const head = `You are \`${node.callsign}\` in collective "${node.scope}".`;
			if (peers.length === 0) {
				return { content: [{ type: "text", text: `${head} No ${filter ? "matching " : ""}peers are live.` }] };
			}
			const lines = peers.map(
				({ record, contact, quiet }) =>
					`- \`${record.callsign}\` — ${record.via} in ${record.cwd} (${record.busy ? "working" : "idle"}${contact ? ", contact" : ""}${quiet ? ", no presence update for 5+ min — may be suspended" : ""})`,
			);
			return {
				content: [{ type: "text", text: `${head} ${peers.length} peer(s):\n${lines.join("\n")}` }],
				details: { peers: peers.map(({ record }) => record) },
			};
		},
	});

	pi.registerTool({
		name: "peer_send",
		label: "Peer Send",
		description:
			"Send a message to another live agent session by callsign (see the peers tool). Use it when the user asks you to tell, ask, or hand work to another session. It is delivered as a real prompt there: it wakes the peer if idle, or lands mid-turn if busy. Fire-and-forget — the peer's reply arrives here as a separate peer message.",
		parameters: {
			type: "object",
			properties: {
				to: { type: "string", description: "Peer callsign, as listed by the peers tool" },
				message: { type: "string", description: "Message body" },
			},
			required: ["to", "message"],
			additionalProperties: false,
		},
		execute: async (_toolCallId, params) => {
			if (!node || node.stopped) {
				return { content: [{ type: "text", text: "The collective node is not running in this process; run /collective to start it." }] };
			}
			const to = typeof params.to === "string" ? params.to.trim().replace(/^@/u, "") : "";
			const message = typeof params.message === "string" ? params.message.trim() : "";
			if (!to || !message) {
				return { content: [{ type: "text", text: "Both `to` and `message` are required." }] };
			}
			return { content: [{ type: "text", text: await node.dispatch(to, message) }] };
		},
	});
}
