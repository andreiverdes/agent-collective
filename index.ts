/**
 * collective — cross-instance peer awareness and steering for omp and pi.
 *
 * Every agent process announces itself into a machine-global rendezvous directory and
 * listens on its own unix socket. What happens next depends on what the host exposes,
 * decided once at module load:
 *
 * **Bridge mode (omp).** Each peer is materialized as a ref in the host's in-process
 * `AgentRegistry` — the single registry the built-in `hub` tool resolves names against —
 * so peers need no new tool surface:
 *   - `hub list`                → other terminals, alongside local subagents
 *   - `hub send to="007" "..."` → real prompt injected into that terminal's agent
 *   - `await: true`             → resolves in-band with the peer's reply
 *
 * **Tool mode (pi).** pi has no IRC bus, no agent registry, and no `hub` tool, and its
 * package exports only `.` and `./rpc-entry`, so nothing is reachable to bridge. Peers
 * are exposed as two registered tools instead (`peers`, `peer_send`), and inbound
 * messages arrive through `sendUserMessage`.
 *
 * Both modes share one registry directory, so an omp instance and a pi instance on the
 * same machine see each other and can talk.
 *
 * Two host quirks worth knowing before editing this file:
 *   - NEVER detach a method from the api object (`const on = pi.on`). omp's ExtensionAPI
 *     methods are class methods that need `this`; pi's are closures. Detaching works on
 *     pi and throws `undefined is not an object (evaluating 'this.extension')` on omp.
 *   - The host rewrites its own package specifiers with an `onResolve` hook scoped to the
 *     extension's load pass, so only *literal* specifiers resolve. `import(someVariable)`
 *     fails even for subpaths that work as literals.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const PROTOCOL = 1;
const BEAT_MS = 1200;
const STALE_MS = 6_000;
const PEER_TIMEOUT_MS = 8_000;
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

/**
 * One directory for every harness on the machine — that is what lets omp and pi peer with
 * each other. Deliberately not derived from any env var: two terminals with different
 * environments must never end up in two separate collectives.
 */
const COLLECTIVE_DIR = path.join(os.homedir(), ".agent-collective");

interface HostBridge {
	registry: RegistryLike;
	mainId: string;
	/** `tools/hub/messaging`'s `executeSend`, which drives the host's real `IrcBus`. */
	send: (
		deps: { registry: unknown; senderId: string; settings: unknown; sessionFileHint: string | null },
		params: { to: string; message: string; replyTo?: string },
	) => Promise<{ details?: { receipts?: { outcome?: string; error?: string }[] } }>;
}

/**
 * Capability probe. Registration (`registerTool`) is load-time only, so the mode has to be
 * known during module evaluation — hence top-level await, verified working on omp 18.1.10
 * (bun) and pi 0.84.2 (node). Dynamic import is required because these specifiers exist on
 * one harness only; a static import of a missing module aborts the whole extension load.
 */
async function probeBridge(): Promise<HostBridge | undefined> {
	try {
		const registryModule = await import("@oh-my-pi/pi-coding-agent/registry/agent-registry");
		const messagingModule = await import("@oh-my-pi/pi-coding-agent/tools/hub/messaging");
		const AgentRegistry = registryModule.AgentRegistry as unknown as { global(): RegistryLike };
		const send = messagingModule.executeSend as unknown as HostBridge["send"];
		if (typeof send !== "function") return undefined;
		return { registry: AgentRegistry.global(), mainId: String(registryModule.MAIN_AGENT_ID ?? "Main"), send };
	} catch {
		return undefined;
	}
}

const bridge = await probeBridge();

/**
 * `executeSend` reads `settings` only to resolve an await timeout (`params.await`), which
 * the inbound path never sets. A real SettingsManager is unreachable from an extension, so
 * this stands in for the unused dependency.
 */
const SETTINGS_UNUSED = { get: () => undefined };

interface PeerRecord {
	v: number;
	pid: number;
	callsign: string;
	cwd: string;
	project: string;
	/** Which harness this peer runs, so a roster row can say so. */
	via: "omp" | "pi";
	sessionId?: string;
	model?: string;
	socket: string;
	startedAt: number;
	beatAt: number;
	busy: boolean;
}

interface IrcMessageLike {
	id: string;
	from: string;
	to: string;
	body: string;
	ts: number;
	replyTo?: string;
}

/**
 * Frame exchanged over a peer's unix socket, one JSON object per line.
 *
 * `hop` is the message's distance from the last human prompt: 0 for a message an agent sends
 * on its own initiative, +1 for each agent-to-agent relay after that. It exists because
 * mutual wake is a *behavioural* loop, not a transport loop — A wakes B, B's resulting turn
 * wakes A, and every individual delivery is a legitimate single hop, so no transport-level
 * guard ever trips. Absent (older peers) is treated as 0.
 */
type PeerFrame =
	| { t: "msg"; from: string; body: string; replyTo?: string; hop?: number }
	| { t: "ping"; from: string };

interface PeerReply {
	ok: boolean;
	outcome?: string;
	callsign?: string;
	error?: string;
}

/** Minimal view of a cloned provider-bound message; only user-role content is touched. */
interface ContextMessageLike {
	role: string;
	content: string | { type: string; text?: string }[];
}

interface SessionLike {
	isStreaming?: boolean;
	/** Present on the host's real AgentSession; the seam `IrcBus` uses for delivery. */
	deliverIrcMessage?: (msg: IrcMessageLike, opts?: { suppressRelay?: boolean }) => Promise<"injected" | "woken">;
	/** Marker identifying a ref this extension owns. */
	peerSocket?: string;
}

interface RefLike {
	id: string;
	kind: string;
	status: string;
	session: SessionLike | null;
}

interface RegistryLike {
	get(id: string): RefLike | undefined;
	list(): RefLike[];
	register(input: {
		id: string;
		displayName: string;
		kind: string;
		status: string;
		session: SessionLike | null;
		sessionFile: string | null;
		activity?: string;
	}): unknown;
	unregister(id: string): boolean;
	setActivity(id: string, activity: string): void;
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
	/** pi has no `"aside"`: an idle send starts a turn, a streaming send must steer. */
	sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" | "aside" }): void;
	logger?: { warn(message: string): void };
}

/** One collective node per process, even when several sessions load the extension. */
let node: CollectiveNode | undefined;

/**
 * Get the live node, starting one if this process has none.
 *
 * Creating the node only inside `session_start` was a latent failure: any path where that
 * handler does not run for the session actually in front of the user — the module loaded
 * after the session began (an install plus `/reload-plugins`), or a session replaced within
 * the process — left the commands registered with nothing behind them, reporting
 * "collective: not started" until the process restarted. Every entry point re-arms instead,
 * so the node exists as soon as anything asks for it.
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

class CollectiveNode {
	readonly #pi: CollectivePi;
	readonly #ctx: CollectiveContext;
	readonly #socketPath = path.join(COLLECTIVE_DIR, `${process.pid}.sock`);
	readonly #recordPath = path.join(COLLECTIVE_DIR, `${process.pid}.json`);
	readonly #startedAt = Date.now();
	/** Remote peers currently materialized in the local registry, keyed by callsign. */
	readonly #peers = new Map<string, PeerRecord>();
	/** Bodies accumulating inside the current burst window, keyed by sender. */
	readonly #pending = new Map<string, { bodies: string[]; hop: number }>();
	/** Hop count of the inbound message whose turn is currently running, if any. */
	#inboundHop: number | undefined;
	#override: string | undefined;
	#callsign: string;
	#server: net.Server | undefined;
	#stopTimer: (() => void) | undefined;
	#stopped = false;

	constructor(pi: CollectivePi, ctx: CollectiveContext) {
		this.#pi = pi;
		this.#ctx = ctx;
		this.#callsign = `${path.basename(ctx.cwd)}-${process.pid}`.slice(0, MAX_CALLSIGN);
	}

	get callsign(): string {
		return this.#callsign;
	}

	get stopped(): boolean {
		return this.#stopped;
	}

	get peers(): PeerRecord[] {
		return [...this.#peers.values()].sort((a, b) => a.callsign.localeCompare(b.callsign));
	}

	start(): void {
		fs.mkdirSync(COLLECTIVE_DIR, { recursive: true, mode: 0o700 });
		fs.rmSync(this.#socketPath, { force: true });
		const server = net.createServer(socket => this.#accept(socket));
		server.on("error", error => this.#pi.logger?.warn(`collective: server error: ${String(error)}`));
		server.listen(this.#socketPath, () => {
			try {
				fs.chmodSync(this.#socketPath, 0o600);
			} catch {
				// Best effort; the directory is already 0700.
			}
		});
		server.unref();
		this.#server = server;
		this.#tick();
		if (this.#ctx.setInterval && this.#ctx.clearTimer) {
			// omp: the managed timer contains a throwing callback and is cleared on shutdown.
			const timer = this.#ctx.setInterval(() => this.#tick(), BEAT_MS);
			this.#stopTimer = () => this.#ctx.clearTimer?.(timer);
		} else {
			// pi: no managed timers, so this callback owns its guard — an escaping throw
			// from a raw interval surfaces as a process-fatal uncaughtException.
			const timer = setInterval(() => {
				try {
					this.#tick();
				} catch (error) {
					this.#pi.logger?.warn(`collective: tick failed: ${String(error)}`);
				}
			}, BEAT_MS);
			timer.unref?.();
			this.#stopTimer = () => clearInterval(timer);
		}
	}

	stop(): void {
		if (this.#stopped) return;
		this.#stopped = true;
		this.#stopTimer?.();
		this.#server?.close();
		fs.rmSync(this.#socketPath, { force: true });
		fs.rmSync(this.#recordPath, { force: true });
		for (const callsign of this.#peers.keys()) this.#releasePeer(callsign);
		this.#peers.clear();
	}

	setOverride(name: string): string {
		this.#override = name.length > 0 ? name : undefined;
		this.#tick();
		return this.#callsign;
	}

	/** Announce, prune dead peers, mirror the live ones into the local registry. */
	#tick(): void {
		if (this.#stopped) return;
		this.#announce();
		const seen = new Set<string>();
		for (const record of this.#readRecords()) {
			if (record.pid === process.pid) continue;
			seen.add(record.callsign);
			const known = this.#peers.get(record.callsign);
			if (!known) {
				if (this.#claimPeer(record)) this.#ctx.ui.notify(`collective: ${record.callsign} joined (${record.project})`, "info");
				continue;
			}
			this.#peers.set(record.callsign, record);
			if (known.pid !== record.pid) this.#claimPeer(record);
			bridge?.registry.setActivity(record.callsign, this.#activityFor(record));
		}
		for (const callsign of [...this.#peers.keys()]) {
			if (seen.has(callsign)) continue;
			this.#releasePeer(callsign);
			this.#peers.delete(callsign);
			this.#ctx.ui.notify(`collective: ${callsign} left`, "info");
		}
		this.#ctx.ui.setStatus("collective", this.#statusLabel());
	}

	/**
	 * Footer chip: names beat a bare count, since the whole point is addressing peers by
	 * callsign. Working peers sort first and carry `*`; peers sharing this cwd sort next,
	 * because those are the ones that can collide with local edits. The chip self-limits —
	 * the status line shrinks other segments rather than this one, and several extensions
	 * share the row.
	 */
	#statusLabel(): string | undefined {
		if (this.#peers.size === 0) return undefined;
		const ordered = this.peers.sort((left, right) => {
			if (left.busy !== right.busy) return left.busy ? -1 : 1;
			const leftLocal = left.cwd === this.#ctx.cwd;
			if (leftLocal !== (right.cwd === this.#ctx.cwd)) return leftLocal ? -1 : 1;
			return left.callsign.localeCompare(right.callsign);
		});
		const shown: string[] = [];
		let width = 0;
		for (const peer of ordered) {
			const clipped =
				peer.callsign.length > MAX_STATUS_NAME ? `${peer.callsign.slice(0, MAX_STATUS_NAME - 1)}…` : peer.callsign;
			const name = peer.busy ? `${clipped}*` : clipped;
			if (shown.length > 0 && width + 1 + name.length > MAX_STATUS_WIDTH) break;
			width += (shown.length > 0 ? 1 : 0) + name.length;
			shown.push(name);
		}
		const hidden = ordered.length - shown.length;
		return `⇄ ${shown.join(" ")}${hidden > 0 ? ` +${hidden}` : ""}`;
	}

	#announce(): void {
		const project = path.basename(this.#ctx.cwd);
		this.#callsign = this.#resolveCallsign(project);
		const record: PeerRecord = {
			v: PROTOCOL,
			pid: process.pid,
			callsign: this.#callsign,
			cwd: this.#ctx.cwd,
			project,
			via: bridge ? "omp" : "pi",
			sessionId: this.#ctx.sessionManager.getSessionId(),
			model: this.#ctx.model?.id,
			socket: this.#socketPath,
			startedAt: this.#startedAt,
			beatAt: Date.now(),
			busy: !this.#ctx.isIdle(),
		};
		const tmp = `${this.#recordPath}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
		fs.renameSync(tmp, this.#recordPath);
	}

	/**
	 * A callsign is an address, so it must be stable and deliberate.
	 *
	 * `/callsign` always wins. A session name is adopted only when the host reports the
	 * title as user-set (omp's `titleSource`), because an auto-generated title is a
	 * model-written sentence that `title.refreshOnReplan` rewrites mid-session — adopting
	 * it would rename the instance and break every peer's addressing. pi reports no title
	 * source, so there the name is adopted only when it already looks like an address:
	 * one token, no whitespace, within the length cap.
	 */
	#resolveCallsign(project: string): string {
		const source = this.#ctx.sessionManager.getHeader?.()?.titleSource;
		const sessionName = this.#pi.getSessionName();
		const adoptable =
			source === "user" ||
			(source === undefined && sessionName !== undefined && /^[\w.-]{1,24}$/u.test(sessionName.trim()));
		const raw = this.#override ?? (adoptable ? sessionName : undefined) ?? "";
		const cleaned = raw
			.trim()
			.replace(/\s+/gu, "-")
			.replace(/[^\w.-]/gu, "")
			.slice(0, MAX_CALLSIGN);
		const fallback = `${project}-${process.pid}`.slice(0, MAX_CALLSIGN);
		let callsign = cleaned.length > 0 && cleaned !== bridge?.mainId ? cleaned : fallback;
		// Two instances may carry the same name; the older pid keeps the bare form.
		const clash = this.#readRecords().find(
			other => other.pid !== process.pid && other.callsign === callsign && other.startedAt <= this.#startedAt,
		);
		if (clash) callsign = `${callsign}-${process.pid}`.slice(0, MAX_CALLSIGN + 8);
		return callsign;
	}

	/** Live records only; dead pids and stale beats are unlinked on sight. */
	#readRecords(): PeerRecord[] {
		let names: string[];
		try {
			names = fs.readdirSync(COLLECTIVE_DIR);
		} catch {
			return [];
		}
		const now = Date.now();
		const records: PeerRecord[] = [];
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			const file = path.join(COLLECTIVE_DIR, name);
			let record: PeerRecord;
			try {
				record = JSON.parse(fs.readFileSync(file, "utf8")) as PeerRecord;
			} catch {
				fs.rmSync(file, { force: true });
				continue;
			}
			if (record.v !== PROTOCOL || typeof record.pid !== "number" || typeof record.callsign !== "string") {
				fs.rmSync(file, { force: true });
				continue;
			}
			if (record.pid !== process.pid) {
				let alive = true;
				try {
					process.kill(record.pid, 0);
				} catch {
					alive = false;
				}
				if (!alive || now - record.beatAt > STALE_MS) {
					fs.rmSync(file, { force: true });
					fs.rmSync(record.socket, { force: true });
					continue;
				}
			}
			records.push(record);
		}
		return records;
	}

	/**
	 * Bridge mode: materialize a peer as a registry ref. `kind: "sub"` + `status: "idle"`
	 * keeps it inside `listVisibleTo`'s flat alive filter and clear of the parked lifecycle
	 * gate, so `hub send` goes straight to the stub's `deliverIrcMessage`.
	 *
	 * Tool mode: there is no registry, so tracking the record is the whole job — the
	 * `peers` / `peer_send` tools read the same map.
	 */
	#claimPeer(record: PeerRecord): boolean {
		if (!bridge) {
			this.#peers.set(record.callsign, record);
			return true;
		}
		const existing = bridge.registry.get(record.callsign);
		if (existing && existing.session?.peerSocket === undefined) {
			this.#pi.logger?.warn(`collective: callsign "${record.callsign}" collides with a local agent; skipping`);
			return false;
		}
		const stub: SessionLike & {
			subscribe: () => () => void;
			subscribeRunState: () => () => void;
			waitForIrcReplies: () => Promise<IrcMessageLike[]>;
		} = {
			isStreaming: false,
			peerSocket: record.socket,
			subscribe: () => () => undefined,
			subscribeRunState: () => () => undefined,
			waitForIrcReplies: async () => [],
			deliverIrcMessage: async msg => {
				const reply = await this.#request(record, {
					t: "msg",
					from: this.#callsign,
					body: msg.body,
					replyTo: msg.replyTo,
					hop: this.#outboundHop(),
				});
				return reply?.outcome === "woken" ? "woken" : "injected";
			},
		};
		bridge.registry.register({
			id: record.callsign,
			displayName: `${record.callsign} · ${record.project}`,
			kind: "sub",
			status: "idle",
			session: stub,
			sessionFile: null,
			activity: this.#activityFor(record),
		});
		this.#peers.set(record.callsign, record);
		return true;
	}

	#releasePeer(callsign: string): void {
		const ref = bridge?.registry.get(callsign);
		if (ref?.session?.peerSocket === undefined) return;
		bridge?.registry.unregister(callsign);
	}

	/** Fire-and-forget send used by tool mode, where no registry stub carries delivery. */
	async dispatch(callsign: string, body: string, replyTo?: string): Promise<string> {
		const record = this.#peers.get(callsign);
		if (!record) return `Unknown peer "${callsign}". Live peers: ${this.peers.map(p => p.callsign).join(", ") || "none"}`;
		const reply = await this.#request(record, {
			t: "msg",
			from: this.#callsign,
			body,
			replyTo,
			hop: this.#outboundHop(),
		});
		if (!reply) return `No response from ${callsign} (socket closed).`;
		if (!reply.ok) return `Delivery to ${callsign} failed: ${reply.error ?? "unknown error"}`;
		return `Delivered to ${callsign} (${reply.outcome ?? "injected"}). Its reply will arrive as a peer message.`;
	}

	/**
	 * Hop count to stamp on an outbound message. A send made during a turn that a peer
	 * message started inherits that message's distance from the human prompt; anything else
	 * begins a fresh chain at 0.
	 */
	#outboundHop(): number {
		return this.#inboundHop === undefined ? 0 : this.#inboundHop + 1;
	}

	/** A human prompt ends the current chain: the next agent-to-agent send starts over. */
	resetLineage(): void {
		this.#inboundHop = undefined;
	}

	#activityFor(record: PeerRecord): string {
		return `${record.via} instance pid ${record.pid} in ${record.cwd}${record.busy ? " (working)" : ""}`;
	}

	/** One request/response round trip over a peer's socket. */
	#request(record: PeerRecord, frame: PeerFrame): Promise<PeerReply | undefined> {
		const { promise, resolve } = Promise.withResolvers<PeerReply | undefined>();
		let settled = false;
		const socket = net.createConnection({ path: record.socket });
		const finish = (value: PeerReply | undefined): void => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(value);
		};
		socket.setTimeout(PEER_TIMEOUT_MS, () => finish({ ok: false, error: "timeout" }));
		socket.on("error", error => finish({ ok: false, error: String(error) }));
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
		socket.on("close", () => finish(undefined));
		return promise;
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
			const outcome = await this.#inject({ from: frame.from, body: body ?? "", replyTo: frame.replyTo, hop: batch.hop });
			socket.write(`${JSON.stringify({ ok: true, outcome })}\n`);
		} catch (error) {
			this.#pending.delete(frame.from);
			socket.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
		}
	}

	/**
	 * Hand an inbound message to the local agent.
	 *
	 * Bridge mode goes through the host's own `hub` send path rather than straight to
	 * `session.deliverIrcMessage`, for one reason: the bus consumes a pending waiter first,
	 * so a peer's `hub send await:true` resolves with this reply instead of timing out.
	 * `settings` is only read on the await path, which this call never takes.
	 *
	 * Tool mode has no bus, so the message becomes a prompt. pi offers no `"aside"`, so an
	 * idle send starts a turn (the wake) and a mid-turn send has to steer — which does
	 * interrupt the running tool batch, unlike bridge mode.
	 */
	async #inject(frame: { from: string; body: string; replyTo?: string; hop: number }): Promise<"injected" | "woken"> {
		// Any send the resulting turn makes inherits this distance from the human prompt.
		this.#inboundHop = frame.hop;
		const remaining = MAX_HOPS - frame.hop;
		const budget =
			remaining <= 1
				? " This chain is at its last hop, so answer your user rather than relaying further."
				: ` ${remaining} relay hops remain in this chain.`;
		const text = `[collective] message from peer \`${frame.from}\`${frame.replyTo ? " (a reply)" : ""}:\n\n${frame.body}\n\nReply with the \`${bridge ? "hub" : "peer_send"}\` tool addressed to \`${frame.from}\` if a response is useful.${budget}`;
		if (!bridge) {
			const idle = this.#ctx.isIdle();
			this.#pi.sendUserMessage(text, idle ? undefined : { deliverAs: "steer" });
			return idle ? "woken" : "injected";
		}
		try {
			const result = await bridge.send(
				{
					registry: bridge.registry,
					senderId: frame.from,
					settings: SETTINGS_UNUSED,
					sessionFileHint: null,
				},
				{ to: bridge.mainId, message: frame.body, ...(frame.replyTo ? { replyTo: frame.replyTo } : {}) },
			);
			const receipt = result.details?.receipts?.[0];
			if (receipt?.outcome === "failed") throw new Error(receipt.error ?? "delivery failed");
			return receipt?.outcome === "woken" ? "woken" : "injected";
		} catch (error) {
			this.#pi.logger?.warn(`collective: bus delivery failed (${String(error)}); falling back to a prompt`);
			this.#pi.sendUserMessage(text, { deliverAs: "aside" });
			return "injected";
		}
	}
}

export default function collective(pi: CollectivePi): void {
	pi.on("session_start", async (_event, ctx) => {
		ensureNode(pi, ctx);
	});

	// A session replaced inside this process (`/new`, `/resume`, `/fork`, `/switch`) tears the
	// node down with its session; the next handler or command re-arms it against the new one.
	pi.on("session_shutdown", async () => {
		node?.stop();
		node = undefined;
	});

	for (const event of ["session_switch", "session_branch", "session_tree"]) {
		pi.on(event, async (_payload, ctx) => {
			ensureNode(pi, ctx);
		});
	}

	/**
	 * A prompt the human typed starts a fresh chain, so the hop counter resets. Extension
	 * sends are excluded: an inbound peer message arrives that way, and treating it as
	 * human input would zero the counter on every relay and defeat the guard.
	 */
	pi.on("input", async event => {
		const { source } = event as { source?: string };
		if (source === "extension") return;
		node?.resetLineage();
	});

	/**
	 * Identity + roster on every LLM call. `before_agent_start` fires once per *user*
	 * prompt, so an IRC-woken turn (exactly the remote-steering case) would run without
	 * it and the agent would not know its own callsign. `context` operates on a clone
	 * that never reaches the transcript, and appending to the last user message keeps
	 * provider role alternation and the cached prompt prefix intact.
	 */
	pi.on("context", async (event, ctx) => {
		// Runs before every model call, so it doubles as the reliable re-arm point.
		const live = ensureNode(pi, ctx);
		const peers = live?.peers ?? [];
		if (!live || peers.length === 0) return;
		const roster = peers
			.map(
				peer =>
					`- \`${peer.callsign}\` — ${peer.via} instance in ${peer.cwd}${peer.busy ? " (working)" : " (idle)"}`,
			)
			.join("\n");
		const how = bridge
			? [
					"They are addressable by callsign through the `hub` tool, exactly like local subagents:",
					'`hub` op=list shows them; `hub` op=send to="<callsign>" injects a real prompt into that terminal\'s agent, and `await: true` returns its reply.',
				]
			: [
					"They are addressable by callsign through the `peers` and `peer_send` tools:",
					"`peers` lists them; `peer_send` injects a real prompt into that instance's agent, and its reply arrives here as a peer message.",
				];
		const note = [
			"<collective-peers>",
			`You are the agent instance with collective callsign \`${node.callsign}\`.`,
			...how,
			"",
			roster,
			"</collective-peers>",
		].join("\n");
		const { messages } = event as { messages: ContextMessageLike[] };
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (!message || message.role !== "user") continue;
			if (typeof message.content === "string") message.content = `${message.content}\n\n${note}`;
			else if (Array.isArray(message.content)) message.content.push({ type: "text", text: note });
			else continue;
			return { messages };
		}
		return { messages: [...messages, { role: "user", content: note }] };
	});

	pi.registerCommand("callsign", {
		description: "Show or set this instance's collective callsign",
		handler: async (args, ctx) => {
			const live = ensureNode(pi, ctx);
			if (!live) return;
			const name = args.trim();
			if (name.length === 0) {
				ctx.ui.notify(`collective callsign: ${live.callsign}`, "info");
				return;
			}
			ctx.ui.notify(`collective callsign: ${live.setOverride(name)}`, "info");
		},
	});

	pi.registerCommand("collective", {
		description: "List live agent instances on this machine",
		handler: async (_args, ctx) => {
			const live = ensureNode(pi, ctx);
			if (!live) return;
			const peers = live.peers;
			const mode = bridge ? "hub bridge" : "peer tools";
			if (peers.length === 0) {
				ctx.ui.notify(`collective: ${live.callsign} via ${mode} — no peers`, "info");
				return;
			}
			const lines = peers.map(
				peer => `${peer.callsign} — ${peer.via}, pid ${peer.pid} · ${peer.cwd}${peer.busy ? " · working" : ""}`,
			);
			ctx.ui.notify(`collective: ${live.callsign} via ${mode}\n${lines.join("\n")}`, "info");
		},
	});

	// Tool mode only: pi has no `hub`, so peers need their own surface. Registration is
	// load-time, which is why the host probe runs at module scope rather than on session
	// start. On omp these would duplicate `hub`, so they are not registered there.
	if (!bridge) {
		pi.registerTool({
			name: "peers",
			label: "Peers",
			description:
				"List the other live agent instances (omp or pi) on this machine, by callsign. Use peer_send to message one.",
			parameters: { type: "object", properties: {}, additionalProperties: false },
			execute: async () => {
				const peers = node?.peers ?? [];
				if (peers.length === 0) {
					return { content: [{ type: "text", text: "No peers. You are the only live instance." }] };
				}
				const lines = peers.map(
					peer =>
						`- ${peer.callsign} — ${peer.via}, pid ${peer.pid}, ${peer.cwd}${peer.busy ? " (working)" : " (idle)"}`,
				);
				return {
					content: [{ type: "text", text: `${peers.length} peer(s):\n${lines.join("\n")}` }],
					details: { peers },
				};
			},
		});

		pi.registerTool({
			name: "peer_send",
			label: "Peer Send",
			description:
				"Send a message to another live agent instance by callsign. It is delivered as a real prompt: it steers the peer mid-turn or wakes it if idle. Fire-and-forget — the peer's reply arrives as a separate peer message.",
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
				const to = typeof params.to === "string" ? params.to.trim() : "";
				const message = typeof params.message === "string" ? params.message.trim() : "";
				if (!to || !message) {
					return { content: [{ type: "text", text: "Both `to` and `message` are required." }] };
				}
				return { content: [{ type: "text", text: await node.dispatch(to, message) }] };
			},
		});
	}
}
