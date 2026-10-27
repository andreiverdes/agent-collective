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
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {
	CHECK_MS,
	CLAIM_WRITE_GRACE_MS,
	RECORD_VERSION,
	RESERVE_MS,
	appendLog,
	claimLive,
	collectiveDir,
	deliver,
	detectWhere,
	listCollective,
	pidAlive,
	processStart,
	readClaim,
	readLog,
	readRecords,
	resolveScope,
	resolveTarget,
	unreachableText,
	type CollectiveEntry,
	type LogEntry,
	type NameClaim,
	type PeerFrame,
	type PeerRecord,
	type Where,
} from "./store.ts";
import { openCollectiveTui, type CollectiveTuiApi, type CustomUi } from "./tui.ts";

/** Record refresh cadence, in checks (~1 min). Only used to show how recent a record is. */
const REFRESH_CHECKS = 12;
const MAX_CALLSIGN = 24;
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

interface CollectiveContext {
	cwd: string;
	/** omp only: identity of the session this extension registration serves. */
	agent?: { kind: "main" | "sub" };
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		setStatus(key: string, text: string | undefined): void;
		/** Both hosts: a focused custom component (the /collective TUI). */
		custom?: CustomUi;
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

/** omp runs task subagents in the parent process; only the top-level session may own a node. */
function isSubagent(ctx: CollectiveContext): boolean {
	return ctx.agent?.kind === "sub";
}

/**
 * Get the live node for the host's current session, starting one if there is none. Every
 * entry point re-arms, so a module loaded after the session began still gets a node as soon
 * as anything asks for one. omp replaces a session in-process (`/resume`, `/new`, `/fork`)
 * without a `session_shutdown`, so a node bound to another session id is stopped here and a
 * fresh one loads the current session's callsign and contacts.
 */
function ensureNode(pi: CollectivePi, ctx: CollectiveContext): CollectiveNode | undefined {
	// A subagent shares its parent's process, node and socket: it must neither replace nor stop them.
	if (isSubagent(ctx)) return undefined;
	if (node && !node.stopped && node.hostSessionId === ctx.sessionManager.getSessionId()) return node;
	node?.stop();
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
	readonly #dir = collectiveDir(this.scope);
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
	/** The session id as the host reported it; a different one means the session was replaced. */
	readonly hostSessionId: string | undefined;
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
	#busySince: number | undefined;
	readonly #where: Where = detectWhere();
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
		this.hostSessionId = ctx.sessionManager.getSessionId();
		this.#sessionId = this.hostSessionId && /^[\w.-]+$/u.test(this.hostSessionId) ? this.hostSessionId : undefined;
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

	get via(): "omp" | "pi" {
		return this.#via;
	}

	get override(): string | undefined {
		return this.#override;
	}

	/** The callsign a rename to `name` would get, without claiming anything. */
	previewName(name: string): { name: string; held: boolean } {
		const owner = readClaim(path.join(this.#namesDir, name));
		const held = typeof owner === "object" && owner.pid !== process.pid && claimLive(owner, this.#processStart !== undefined);
		return { name, held };
	}

	/** Everyone else in the collective, contacts first; read from disk on every call. */
	entries(): (CollectiveEntry & { contact: boolean })[] {
		return listCollective(this.#dir)
			.map(entry => ({ ...entry, contact: this.#contacts.has(entry.callsign) }))
			.sort((a, b) =>
				a.contact !== b.contact
					? a.contact ? -1 : 1
					: (a.state === "offline") !== (b.state === "offline")
						? a.state === "offline" ? 1 : -1
						: a.callsign.localeCompare(b.callsign),
			);
	}

	/** What this session and `peer` said, oldest first; all messages when `peer` is omitted. */
	thread(peer?: string): LogEntry[] {
		return this.#sessionId ? readLog(this.#dir, this.#sessionId, peer) : [];
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
		this.#leaveClaim();
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
		this.#busySince = busy ? Date.now() : undefined;
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
			busySince: this.#busySince,
			where: this.#where,
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

	/** True when `names/<name>` currently names this process's running session. */
	#holds(name: string): boolean {
		const owner = readClaim(path.join(this.#namesDir, name));
		return typeof owner === "object" && owner.pid === process.pid && !owner.left;
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
		if (owner.pid === process.pid && !owner.left) return false;
		if (exact ? claimLive(owner, this.#processStart !== undefined) : !owner.left && pidAlive(owner.pid)) return true;
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
		const mine: NameClaim = {
			pid: process.pid,
			start: this.#processStart,
			sessionId: this.#sessionId,
			cwd: this.#ctx.cwd,
			via: this.#via,
		};
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

	/**
	 * The session is leaving this process (exit, or omp swapping in another session): mark the
	 * claim `left` so it no longer counts as held by this still-running pid. It stays reserved
	 * for this session, and the rewrite stamps the mtime the reservation clock runs from.
	 */
	#leaveClaim(): void {
		const file = path.join(this.#namesDir, this.#callsign);
		const owner = readClaim(file);
		if (typeof owner !== "object" || owner.pid !== process.pid || owner.left) return;
		const aside = path.join(this.#namesDir, `.left-${process.pid}-${Date.now()}`);
		try {
			fs.writeFileSync(aside, JSON.stringify({ ...owner, left: true }), { mode: 0o600 });
			fs.renameSync(aside, file);
		} catch (error) {
			fs.rmSync(aside, { force: true });
			this.#pi.logger?.warn(`collective: could not release callsign claim: ${String(error)}`);
		}
	}

	/** Give up `name` outright (a rename away from it): it is not reserved. */
	#release(name: string): void {
		if (name !== "" && this.#holds(name)) fs.rmSync(path.join(this.#namesDir, name), { force: true });
	}

	/** Running peers only, contacts first: what the `peers` tool and `/collective` text list. */
	listPeers(): (CollectiveEntry & { contact: boolean; record: PeerRecord })[] {
		return this.entries().filter((entry): entry is CollectiveEntry & { contact: boolean; record: PeerRecord } => entry.record !== undefined);
	}

	/**
	 * Send `body` to `callsign` and log the outcome. `fromUser` marks a message the person at
	 * this terminal typed (the TUI composer): it starts a fresh chain at hop 0, whatever turn
	 * this session is in.
	 */
	async send(
		callsign: string,
		body: string,
		options: { replyTo?: string; fromUser?: boolean } = {},
	): Promise<{ ok: boolean; outcome: string; text: string }> {
		const target = resolveTarget(this.#dir, callsign);
		const hop = options.fromUser ? 0 : this.#outboundHop(callsign);
		const human = options.fromUser || undefined;
		if (target.kind !== "live") {
			if (target.kind === "offline") this.#log({ at: Date.now(), dir: "out", peer: callsign, hop, outcome: "offline", body, human });
			return { ok: false, outcome: target.kind, text: unreachableText(callsign, this.scope, target) };
		}
		const frame: PeerFrame = { t: "msg", from: this.#callsign, body, replyTo: options.replyTo, hop };
		const reply = await deliver(target.record, frame);
		const outcome = reply.ok ? (reply.outcome ?? "injected") : reply.error?.startsWith("Refused") ? "refused" : "failed";
		this.#log({ at: Date.now(), dir: "out", peer: callsign, hop, outcome, body, human });
		if (!reply.ok) return { ok: false, outcome, text: `Delivery to ${callsign} failed: ${reply.error ?? "unknown error"}` };
		this.#addContact(callsign);
		return { ok: true, outcome, text: `Delivered to ${callsign} (${outcome}). Its reply will arrive as a peer message.` };
	}

	async dispatch(callsign: string, body: string, replyTo?: string): Promise<string> {
		return (await this.send(callsign, body, { replyTo })).text;
	}

	/** Append to this session's message log; a session without an id keeps none. */
	#log(entry: LogEntry): void {
		if (!this.#sessionId) return;
		try {
			appendLog(this.#dir, this.#sessionId, entry);
		} catch (error) {
			this.#pi.logger?.warn(`collective: could not write message log: ${String(error)}`);
		}
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
		const human = frame.human === true;
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
			const outcome = this.#inject({ from: frame.from, body: body ?? "", replyTo: frame.replyTo, hop: batch.hop, human });
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
	 *
	 * A message from a person (CLI, Tern block) is not a relay: it starts no chain, adds no
	 * contact, and the agent is told to answer in its own pane, since there is no callsign to
	 * reply to.
	 *
	 * A peer's message may answer something this session's user sent it from /collective, which
	 * never entered the agent's conversation; those messages are quoted ahead of it.
	 */
	#inject(frame: { from: string; body: string; replyTo?: string; hop: number; human: boolean }): "woken" | "aside" | "steered" {
		const wakes = this.#ctx.isIdle();
		let text: string;
		if (frame.human) {
			if (wakes) this.resetLineage();
			text = `[collective] message from ${frame.from} to you (\`${this.#callsign}\`):\n\n${frame.body}\n\nThis came from the user, not from another session: answer here, not with peer_send.`;
		} else {
			// Any send the resulting turn makes inherits this distance from the human prompt.
			this.#recordInbound(frame.from, frame.hop, wakes);
			this.#addContact(frame.from);
			// Sends a reply to this peer may still make, counting the reply itself.
			const remaining = MAX_HOPS - this.#outboundHop(frame.from) + 1;
			const budget =
				remaining <= 1
					? " This chain is at its last hop, so answer your user rather than relaying further."
					: ` ${remaining} relay hops remain in this chain.`;
			const asks = this.#unseenAsks(frame.from);
			const context = asks.length
				? `Before this, your user sent \`${frame.from}\` ${asks.length === 1 ? "this message" : "these messages"} from /collective, outside this conversation:\n\n${asks.map(ask => ask.replace(/^/gmu, "> ")).join("\n\n")}\n\nIts message:\n\n`
				: "";
			text = `[collective] message from peer \`${frame.from}\`${frame.replyTo ? " (a reply)" : ""} to you (\`${this.#callsign}\`):\n\n${context}${frame.body}\n\nReply with the \`peer_send\` tool addressed to \`${frame.from}\` if a response is useful.${budget}`;
		}
		this.#log({ at: Date.now(), dir: "in", peer: frame.from, hop: frame.hop, body: frame.body, human: frame.human || undefined });
		if (wakes) {
			this.#pi.sendUserMessage(text);
			return "woken";
		}
		this.#pi.sendUserMessage(text, { deliverAs: this.#via === "omp" ? "aside" : "steer" });
		return this.#via === "omp" ? "aside" : "steered";
	}

	/**
	 * What this session's user sent `peer` from /collective since the last message the agent
	 * got from it: the agent has not seen those. Undelivered ones are left out.
	 */
	#unseenAsks(peer: string): string[] {
		const asks: string[] = [];
		for (const entry of this.thread(peer)) {
			if (entry.dir === "in") asks.length = 0;
			else if (entry.human && entry.outcome !== "refused" && entry.outcome !== "offline" && entry.outcome !== "failed") asks.push(entry.body);
		}
		return asks;
	}
}

export default function collective(pi: CollectivePi): void {
	for (const event of ["session_start", "session_switch", "session_branch", "session_tree"]) {
		pi.on(event, async (_payload, ctx) => {
			ensureNode(pi, ctx);
		});
	}

	// The host is disposing of the session (exit, or pi tearing it down to replace it); the next
	// handler or command re-arms a node against whatever session comes next. A subagent's
	// shutdown must not stop the node its parent owns.
	pi.on("session_shutdown", async (_payload, ctx) => {
		if (isSubagent(ctx)) return;
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
		if (isSubagent(ctx)) return;
		live?.resetLineage();
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (isSubagent(ctx)) return;
		ensureNode(pi, ctx)?.setBusy(true);
	});

	/**
	 * A finished turn owes nothing to the messages it answered, and is the moment the
	 * instance becomes idle — the only other time its record changes.
	 */
	pi.on("agent_end", async (_event, ctx) => {
		if (isSubagent(ctx)) return;
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
		description: "Browse and message the sessions in this collective (this omp profile)",
		handler: async (_args, ctx) => {
			const live = ensureNode(pi, ctx);
			if (!live) return;
			if (ctx.ui.custom) {
				const api: CollectiveTuiApi = {
					scope: live.scope,
					via: live.via,
					callsign: () => live.callsign,
					override: () => live.override,
					entries: () => live.entries(),
					thread: peer => live.thread(peer),
					send: (callsign, body) => live.send(callsign, body, { fromUser: true }),
					rename: name => live.setOverride(name),
					previewName: name => live.previewName(name),
				};
				await openCollectiveTui(ctx.ui.custom.bind(ctx.ui), api);
				return;
			}
			// Hosts without custom components (print/RPC modes): a plain listing.
			const entries = live.entries();
			const head = `collective "${live.scope}": you are ${live.callsign}`;
			const lines = entries.map(
				entry =>
					`${entry.contact ? "★ " : ""}${entry.callsign} — ${entry.state}${entry.via ? `, ${entry.via}` : ""}${entry.cwd ? ` · ${entry.cwd}` : ""}`,
			);
			ctx.ui.notify(lines.length > 0 ? `${head}\n${lines.join("\n")}` : `${head} — no peers`, "info");
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
				({ record, contact, state }) =>
					`- \`${record.callsign}\` — ${record.via} in ${record.cwd} (${record.busy ? "working" : "idle"}${contact ? ", contact" : ""}${state === "quiet" ? ", no presence update for 5+ min — may be suspended" : ""})`,
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
