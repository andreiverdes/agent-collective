/**
 * hive — cross-instance peer awareness and steering for omp.
 *
 * Every omp process announces itself into a machine-global rendezvous directory and
 * listens on its own unix socket. Each instance then materializes every *other* live
 * instance as a ref in the host's in-process `AgentRegistry`, which is the single
 * registry the built-in `hub` tool resolves names against. Consequences:
 *
 *   - `hub list`                     → shows other terminals alongside local subagents
 *   - `hub send to="007" "..."`      → real prompt injected into that terminal's agent
 *   - the peer's reply (`hub send`)  → arrives here as a normal IRC aside
 *
 * Callsign = `/callsign <name>` override, else the session name (so builtin
 * `/rename 007` names the instance), else `omp-<pid>`.
 *
 * The specifier below is rewritten by the host loader onto its own bundled module
 * graph, so these are the live singletons the `hub` tool uses — verified at runtime
 * against a compiled 18.1.6 binary. The compiled binary ships no type declarations,
 * hence the structural interfaces here.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { executeSend } from "@oh-my-pi/pi-coding-agent/tools/hub/messaging";

const PROTOCOL = 1;
const BEAT_MS = 1200;
const STALE_MS = 6_000;
const PEER_TIMEOUT_MS = 8_000;
const MAX_CALLSIGN = 24;
const MAX_STATUS_NAME = 12;
const MAX_STATUS_WIDTH = 32;

const HIVE_DIR = path.join(
	process.env.XDG_STATE_HOME ? path.join(process.env.XDG_STATE_HOME, "omp") : path.join(os.homedir(), ".omp"),
	"run",
	"hive",
);

/**
 * `executeSend` reads `settings` only to resolve an await timeout (`params.await`),
 * which the inbound bridge never sets. A real SettingsManager is unreachable from an
 * extension, so this stands in for the unused dependency.
 */
const SETTINGS_UNUSED = { get: () => undefined } as unknown as Parameters<typeof executeSend>[0]["settings"];

interface HiveRecord {
	v: number;
	pid: number;
	callsign: string;
	cwd: string;
	project: string;
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

/** Frame exchanged over a peer's unix socket, one JSON object per line. */
type HiveFrame =
	| { t: "msg"; from: string; body: string; replyTo?: string }
	| { t: "ping"; from: string };

interface HiveReply {
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
	hiveSocket?: string;
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

interface HiveContext {
	cwd: string;
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		setStatus(key: string, text: string | undefined): void;
	};
	isIdle(): boolean;
	sessionManager: {
		getSessionId(): string | undefined;
		/** Header carries `titleSource`, which distinguishes `/rename` from auto titles. */
		getHeader?(): { titleSource?: string } | undefined;
	};
	model?: { id?: string };
	setInterval(callback: () => void, ms?: number): unknown;
	clearTimer(timer: unknown): void;
}

interface HivePi {
	on(event: string, handler: (event: unknown, ctx: HiveContext) => Promise<void> | void): void;
	registerCommand(
		name: string,
		options: { description?: string; handler: (args: string, ctx: HiveContext) => Promise<void> },
	): void;
	getSessionName(): string | undefined;
	sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" | "aside" }): void;
	logger?: { warn(message: string): void };
}

// The host module is untyped at author time (no d.ts in the compiled binary); this is the
// documented shape, confirmed against src/registry/agent-registry.ts:139-261 of 18.1.6.
const registry = (): RegistryLike => AgentRegistry.global() as unknown as RegistryLike;

/** One hive node per process, even when several sessions load the extension. */
let node: HiveNode | undefined;

class HiveNode {
	readonly #pi: HivePi;
	readonly #ctx: HiveContext;
	readonly #socketPath = path.join(HIVE_DIR, `${process.pid}.sock`);
	readonly #recordPath = path.join(HIVE_DIR, `${process.pid}.json`);
	readonly #startedAt = Date.now();
	/** Remote peers currently materialized in the local registry, keyed by callsign. */
	readonly #peers = new Map<string, HiveRecord>();
	#override: string | undefined;
	#callsign: string;
	#server: net.Server | undefined;
	#timer: unknown;
	#stopped = false;

	constructor(pi: HivePi, ctx: HiveContext) {
		this.#pi = pi;
		this.#ctx = ctx;
		this.#callsign = `omp-${process.pid}`;
	}

	get callsign(): string {
		return this.#callsign;
	}

	get peers(): HiveRecord[] {
		return [...this.#peers.values()].sort((a, b) => a.callsign.localeCompare(b.callsign));
	}

	start(): void {
		fs.mkdirSync(HIVE_DIR, { recursive: true, mode: 0o700 });
		fs.rmSync(this.#socketPath, { force: true });
		const server = net.createServer(socket => this.#accept(socket));
		server.on("error", error => this.#pi.logger?.warn(`hive: server error: ${String(error)}`));
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
		this.#timer = this.#ctx.setInterval(() => this.#tick(), BEAT_MS);
	}

	stop(): void {
		if (this.#stopped) return;
		this.#stopped = true;
		if (this.#timer !== undefined) this.#ctx.clearTimer(this.#timer);
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
				if (this.#claimPeer(record)) this.#ctx.ui.notify(`hive: ${record.callsign} joined (${record.project})`, "info");
				continue;
			}
			this.#peers.set(record.callsign, record);
			if (known.pid !== record.pid) this.#claimPeer(record);
			registry().setActivity(record.callsign, this.#activityFor(record));
		}
		for (const callsign of [...this.#peers.keys()]) {
			if (seen.has(callsign)) continue;
			this.#releasePeer(callsign);
			this.#peers.delete(callsign);
			this.#ctx.ui.notify(`hive: ${callsign} left`, "info");
		}
		this.#ctx.ui.setStatus("hive", this.#statusLabel());
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
		// A callsign is an address, so it must be stable. `/rename` and `/callsign` are
		// deliberate ("user"); an auto-generated title is a model-written sentence that
		// also gets rewritten on replan, so adopting it would rename an instance —
		// and break every peer's addressing — mid-session.
		const titled = this.#ctx.sessionManager.getHeader?.()?.titleSource === "user";
		const raw = this.#override ?? (titled ? this.#pi.getSessionName() : undefined) ?? "";
		const cleaned = raw
			.trim()
			.replace(/\s+/gu, "-")
			.replace(/[^\w.-]/gu, "")
			.slice(0, MAX_CALLSIGN);
		let callsign =
			cleaned.length > 0 && cleaned !== MAIN_AGENT_ID ? cleaned : `${project}-${process.pid}`.slice(0, MAX_CALLSIGN);
		// Two instances may carry the same name; the older pid keeps the bare form.
		const clash = this.#readRecords().find(
			other => other.pid !== process.pid && other.callsign === callsign && other.startedAt <= this.#startedAt,
		);
		if (clash) callsign = `${callsign}-${process.pid}`.slice(0, MAX_CALLSIGN + 8);
		this.#callsign = callsign;

		const record: HiveRecord = {
			v: PROTOCOL,
			pid: process.pid,
			callsign,
			cwd: this.#ctx.cwd,
			project,
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

	/** Live records only; dead pids and stale beats are unlinked on sight. */
	#readRecords(): HiveRecord[] {
		let names: string[];
		try {
			names = fs.readdirSync(HIVE_DIR);
		} catch {
			return [];
		}
		const now = Date.now();
		const records: HiveRecord[] = [];
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			const file = path.join(HIVE_DIR, name);
			let record: HiveRecord;
			try {
				record = JSON.parse(fs.readFileSync(file, "utf8")) as HiveRecord;
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
	 * Materialize a peer as a registry ref. `kind: "sub"` + `status: "idle"` keeps it
	 * inside `listVisibleTo`'s flat alive filter and clear of the parked lifecycle gate,
	 * so `hub send` goes straight to the stub's `deliverIrcMessage`.
	 */
	#claimPeer(record: HiveRecord): boolean {
		const existing = registry().get(record.callsign);
		if (existing && existing.session?.hiveSocket === undefined) {
			this.#pi.logger?.warn(`hive: callsign "${record.callsign}" collides with a local agent; skipping`);
			return false;
		}
		const stub: SessionLike & {
			subscribe: () => () => void;
			subscribeRunState: () => () => void;
			waitForIrcReplies: () => Promise<IrcMessageLike[]>;
		} = {
			isStreaming: false,
			hiveSocket: record.socket,
			subscribe: () => () => undefined,
			subscribeRunState: () => () => undefined,
			waitForIrcReplies: async () => [],
			deliverIrcMessage: async msg => {
				const reply = await this.#request(record, { t: "msg", from: this.#callsign, body: msg.body, replyTo: msg.replyTo });
				const outcome = reply?.outcome;
				return outcome === "woken" ? "woken" : "injected";
			},
		};
		registry().register({
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
		const ref = registry().get(callsign);
		if (ref?.session?.hiveSocket === undefined) return;
		registry().unregister(callsign);
	}

	#activityFor(record: HiveRecord): string {
		return `omp instance pid ${record.pid} in ${record.cwd}${record.busy ? " (working)" : ""}`;
	}

	/** One request/response round trip over a peer's socket. */
	#request(record: HiveRecord, frame: HiveFrame): Promise<HiveReply | undefined> {
		const { promise, resolve } = Promise.withResolvers<HiveReply | undefined>();
		let settled = false;
		const socket = net.createConnection({ path: record.socket });
		const finish = (value: HiveReply | undefined): void => {
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
				finish(JSON.parse(buffer.slice(0, line)) as HiveReply);
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
		let frame: HiveFrame;
		try {
			frame = JSON.parse(line) as HiveFrame;
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
		try {
			const outcome = await this.#inject(frame);
			socket.write(`${JSON.stringify({ ok: true, outcome })}\n`);
		} catch (error) {
			socket.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
		}
	}

	/**
	 * Hand an inbound message to the local agent through the host's own `hub` send path.
	 * Going through `executeSend` rather than straight to `session.deliverIrcMessage`
	 * matters for one reason: the bus consumes a pending waiter first, so a peer's
	 * `hub send await:true` actually resolves with this reply instead of timing out.
	 * `settings` is only read on the await path, which this call never takes.
	 */
	async #inject(frame: { from: string; body: string; replyTo?: string }): Promise<"injected" | "woken"> {
		try {
			const result = await executeSend(
				{
					registry: AgentRegistry.global(),
					senderId: frame.from,
					settings: SETTINGS_UNUSED,
					sessionFileHint: null,
				},
				{ to: MAIN_AGENT_ID, message: frame.body, ...(frame.replyTo ? { replyTo: frame.replyTo } : {}) },
			);
			const receipt = result.details?.receipts?.[0];
			if (receipt?.outcome === "failed") throw new Error(receipt.error ?? "delivery failed");
			return receipt?.outcome === "woken" ? "woken" : "injected";
		} catch (error) {
			this.#pi.logger?.warn(`hive: bus delivery failed (${String(error)}); falling back to aside`);
			this.#pi.sendUserMessage(`[hive ${frame.from}] ${frame.body}`, { deliverAs: "aside" });
			return "injected";
		}
	}
}

export default function hive(pi: HivePi): void {
	pi.on("session_start", async (_event, ctx) => {
		if (node) return;
		node = new HiveNode(pi, ctx);
		node.start();
	});

	pi.on("session_shutdown", async () => {
		node?.stop();
		node = undefined;
	});

	/**
	 * Identity + roster on every LLM call. `before_agent_start` fires once per *user*
	 * prompt, so an IRC-woken turn (exactly the remote-steering case) would run without
	 * it and the agent would not know its own callsign. `context` operates on a clone
	 * that never reaches the transcript, and appending to the last user message keeps
	 * provider role alternation and the cached prompt prefix intact.
	 */
	pi.on("context", async event => {
		const peers = node?.peers ?? [];
		if (!node || peers.length === 0) return;
		const roster = peers
			.map(peer => `- \`${peer.callsign}\` — omp instance in ${peer.cwd}${peer.busy ? " (working)" : " (idle)"}`)
			.join("\n");
		const note = [
			"<hive-peers>",
			`You are the omp instance with hive callsign \`${node.callsign}\`.`,
			"Other live omp instances on this machine are addressable by callsign through the `hub` tool, exactly like local subagents:",
			'`hub` op=list shows them; `hub` op=send to="<callsign>" injects a real prompt into that terminal\'s agent and its reply comes back to you as a peer message.',
			"",
			roster,
			"</hive-peers>",
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
		description: "Show or set this instance's hive callsign",
		handler: async (args, ctx) => {
			if (!node) {
				ctx.ui.notify("hive: not started", "warning");
				return;
			}
			const name = args.trim();
			if (name.length === 0) {
				ctx.ui.notify(`hive callsign: ${node.callsign}`, "info");
				return;
			}
			ctx.ui.notify(`hive callsign: ${node.setOverride(name)}`, "info");
		},
	});

	pi.registerCommand("hive", {
		description: "List live omp instances on this machine",
		handler: async (_args, ctx) => {
			if (!node) {
				ctx.ui.notify("hive: not started", "warning");
				return;
			}
			const peers = node.peers;
			if (peers.length === 0) {
				ctx.ui.notify(`hive: ${node.callsign} (no peers)`, "info");
				return;
			}
			const lines = peers.map(peer => `${peer.callsign} — pid ${peer.pid} · ${peer.cwd}${peer.busy ? " · working" : ""}`);
			ctx.ui.notify(`hive: ${node.callsign}\n${lines.join("\n")}`, "info");
		},
	});
}
