/**
 * On-disk state of a collective, shared by the extension (index.ts), the /collective TUI
 * (tui.ts) and the CLI (bin/agent-collective.ts). Nothing here needs a host: it reads and
 * writes `~/.agent-collective/<profile>/` and talks to peers' sockets.
 *
 * Layout of a collective directory:
 *   <pid>.json                  presence record of a running session (written by its owner)
 *   <pid>.sock                  that session's socket
 *   names/<callsign>            claim: which session holds a callsign (mtime = last ran)
 *   sessions/<id>.json          per-session state: callsign, /callsign override, contacts
 *   sessions/<id>.log.jsonl     per-session message log, last LOG_KEEP messages
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/** Presence record layout. 0.3.x wrote v1 records to the root directory; they are ignored. */
export const RECORD_VERSION = 2;
/** How often a running session checks that its socket is still reachable at its path. */
export const CHECK_MS = 5_000;
/** A record not refreshed this long is shown as possibly unreachable; it is never deleted. */
export const QUIET_MS = 5 * 60_000;
/** How long a sender waits for a live peer to re-bind a lost socket before giving up. */
export const HEAL_WAIT_MS = CHECK_MS + 2_000;
export const PEER_TIMEOUT_MS = 8_000;
/** An unreadable claim younger than this is mid-write, not corrupt. */
export const CLAIM_WRITE_GRACE_MS = 10_000;
/**
 * How long a callsign stays reserved for its session after that session last ran. Within
 * it, nobody else is given the name and a resume takes it back; after it, the name is free.
 */
export const RESERVE_MS = 7 * 24 * 60 * 60_000;
/** Messages kept per session log. */
export const LOG_KEEP = 500;

/**
 * Root of every collective. Deliberately not derived from any agent-dir env var: omp and pi
 * must land in the same place when they share a profile.
 */
export const COLLECTIVE_ROOT = path.join(os.homedir(), ".agent-collective");

/** A valid profile name, or undefined. Same rule omp applies to `--profile`. */
export function cleanProfile(raw: string | undefined): string | undefined {
	const name = (raw ?? "").trim();
	return /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(name) && !name.endsWith(".") ? name : undefined;
}

/**
 * The collective this process belongs to. omp exports the active profile into both env
 * vars when started with `--profile`; pi has no profiles, so it is always `default`.
 */
export function resolveScope(): string {
	return cleanProfile(process.env.OMP_PROFILE ?? process.env.PI_PROFILE) ?? "default";
}

export function collectiveDir(scope: string): string {
	return path.join(COLLECTIVE_ROOT, scope);
}

/** Profiles that have a collective directory, sorted. */
export function listProfiles(): string[] {
	try {
		return fs
			.readdirSync(COLLECTIVE_ROOT, { withFileTypes: true })
			.filter(entry => entry.isDirectory() && cleanProfile(entry.name) === entry.name)
			.map(entry => entry.name)
			.sort();
	} catch {
		return [];
	}
}

/** Where a session's terminal lives, so a viewer can jump to it. */
export interface Where {
	/** Tern block id (`TERN_PANE`); `tern focus <pane>` shows it. */
	tern?: { pane: string };
	/** herdr pane id and the herdr server socket it belongs to. */
	herdr?: { pane: string; socket?: string };
	/** Controlling terminal, as `ps` names it (`ttys012`). */
	tty?: string;
}

export interface PeerRecord {
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
	/** When the running turn started; set only while busy. */
	busySince?: number;
	where?: Where;
}

/**
 * Frame exchanged over a peer's unix socket, one JSON object per line.
 *
 * `hop` is the message's distance from a human prompt: 0 for a message an agent sends on
 * its own initiative, otherwise one more than the message it answers. It exists because
 * mutual wake is a *behavioural* loop, not a transport loop — A wakes B, B's resulting turn
 * wakes A, and every individual delivery is a legitimate single hop, so no transport-level
 * guard ever trips. Absent is treated as 0.
 *
 * `human` marks a message a person typed outside any session (the CLI, the Tern block):
 * `from` is then a label, not a callsign, and there is nobody to reply to by peer_send.
 */
export type PeerFrame =
	| { t: "msg"; from: string; body: string; replyTo?: string; hop?: number; human?: boolean }
	| { t: "ping"; from: string };

export interface PeerReply {
	ok: boolean;
	outcome?: string;
	callsign?: string;
	error?: string;
	/** Set locally when the connection itself failed (`ENOENT`, `ECONNREFUSED`, ...). */
	transport?: string;
}

/** Contents of `names/<callsign>`: which session holds that callsign. */
export interface NameClaim {
	pid: number;
	start?: string;
	sessionId?: string;
	/** Shown for an offline callsign, whose record is gone. */
	cwd?: string;
	via?: "omp" | "pi";
	/**
	 * The session has left its process (exit, or the host swapped in another session), which
	 * may still be running: the claim is only a reservation now, whatever `pid` says.
	 */
	left?: true;
}

/** True while `pid` exists. EPERM means it exists under another user, which still counts. */
export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function ps(field: string, pid: number): string | undefined {
	try {
		const out = execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], {
			encoding: "utf8",
			env: { ...process.env, LC_ALL: "C" },
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return out.length > 0 ? out : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The OS start time of `pid`. With the pid it identifies one process, so a claim left by a
 * crashed session is not mistaken for live when its pid has been reused. Undefined when `ps`
 * is unavailable; callers then fall back to the pid alone.
 */
export function processStart(pid: number): string | undefined {
	return ps("lstart", pid);
}

/** Where this process's terminal lives, from the environment its terminal gave it. */
export function detectWhere(): Where {
	const where: Where = {};
	const tern = process.env.TERN_PANE?.trim();
	if (tern) where.tern = { pane: tern };
	const herdr = process.env.HERDR_PANE_ID?.trim();
	if (process.env.HERDR_ENV === "1" && herdr) where.herdr = { pane: herdr, socket: process.env.HERDR_SOCKET_PATH };
	const tty = ps("tty", process.pid);
	if (tty && tty !== "??" && tty !== "?") where.tty = tty;
	return where;
}

/** A claim file's owner, `"missing"`, or `"unreadable"` (mid-write, or left corrupt by a crash). */
export function readClaim(file: string): NameClaim | "missing" | "unreadable" {
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
 * A claim is live while its pid exists and, when both sides know it, its start time matches.
 * `psWorks` is false when this process could not read its own start time.
 */
export function claimLive(owner: NameClaim, psWorks: boolean): boolean {
	if (owner.left || !pidAlive(owner.pid)) return false;
	if (owner.start === undefined || !psWorks) return true;
	return processStart(owner.pid) === owner.start;
}

/**
 * Every record in the collective whose process still exists. A dead process's record and
 * socket are removed; a live process's files are NEVER touched, however stale its record
 * looks — a laptop sleep or a stalled event loop is not death, and unlinking a live
 * listener's socket strands it unreachable for good.
 */
export function readRecords(dir: string): PeerRecord[] {
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const records: PeerRecord[] = [];
	for (const name of names) {
		if (!/^\d+\.json$/u.test(name)) continue;
		const file = path.join(dir, name);
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
			if (record.socket.startsWith(dir)) fs.rmSync(record.socket, { force: true });
			continue;
		}
		records.push(record);
	}
	return records;
}

export type EntryState = "working" | "idle" | "quiet" | "offline";

/** One row of a collective listing: a running session, or an offline (reserved) callsign. */
export interface CollectiveEntry {
	callsign: string;
	state: EntryState;
	pid?: number;
	cwd?: string;
	via?: "omp" | "pi";
	model?: string;
	sessionId?: string;
	busySince?: number;
	beatAt?: number;
	/** Offline only: when its session last ran. */
	lastRanAt?: number;
	where?: Where;
	/** Running sessions only. */
	record?: PeerRecord;
}

/**
 * Everyone in the collective except `selfPid`: running sessions from their records, then
 * offline callsigns still reserved for their session, from `names/`. Read on demand.
 */
export function listCollective(dir: string, selfPid: number = process.pid): CollectiveEntry[] {
	const now = Date.now();
	const records = readRecords(dir);
	const live = new Set(records.map(record => record.pid));
	const entries: CollectiveEntry[] = records
		.filter(record => record.pid !== selfPid)
		.map(record => ({
			callsign: record.callsign,
			state: now - record.beatAt > QUIET_MS ? "quiet" : record.busy ? "working" : "idle",
			pid: record.pid,
			cwd: record.cwd,
			via: record.via,
			model: record.model,
			sessionId: record.sessionId,
			busySince: record.busySince,
			beatAt: record.beatAt,
			where: record.where,
			record,
		}));
	const namesDir = path.join(dir, "names");
	let names: string[] = [];
	try {
		names = fs.readdirSync(namesDir);
	} catch {
		// No claims yet.
	}
	const listed = new Set(entries.map(entry => entry.callsign));
	for (const name of names) {
		if (name.startsWith(".") || listed.has(name)) continue;
		const file = path.join(namesDir, name);
		const owner = readClaim(file);
		if (typeof owner !== "object" || owner.sessionId === undefined || (!owner.left && live.has(owner.pid))) continue;
		let lastRanAt: number;
		try {
			lastRanAt = fs.statSync(file).mtimeMs;
		} catch {
			continue;
		}
		if (now - lastRanAt >= RESERVE_MS) continue;
		entries.push({ callsign: name, state: "offline", cwd: owner.cwd, via: owner.via, sessionId: owner.sessionId, lastRanAt });
	}
	return entries;
}

/** Who a callsign reaches right now. */
export type Target =
	| { kind: "live"; record: PeerRecord }
	| { kind: "offline"; lastRanAt: number }
	| { kind: "unknown"; suggestions: string[] };

/**
 * Resolve a callsign through its claim — the single source of truth for who holds it;
 * records only carry a copy. Records are matched by name alone for peers on 0.4.0, which
 * wrote no claims.
 */
export function resolveTarget(dir: string, callsign: string, selfPid: number = process.pid): Target {
	const peers = readRecords(dir).filter(record => record.pid !== selfPid);
	const file = path.join(dir, "names", callsign);
	const owner = readClaim(file);
	const record =
		typeof owner === "object"
			? owner.left ? undefined : peers.find(peer => peer.pid === owner.pid)
			: owner === "missing"
				? peers.find(peer => peer.callsign === callsign)
				: undefined;
	if (record) return { kind: "live", record };
	if (typeof owner === "object" && owner.sessionId !== undefined) {
		try {
			const lastRanAt = fs.statSync(file).mtimeMs;
			if (Date.now() - lastRanAt < RESERVE_MS) return { kind: "offline", lastRanAt };
		} catch {
			// Claim vanished meanwhile.
		}
	}
	const needle = callsign.toLowerCase();
	return { kind: "unknown", suggestions: peers.map(peer => peer.callsign).filter(name => name.toLowerCase().includes(needle)) };
}

/** "3 min", "5 h", "2 days". */
export function formatAgo(ms: number): string {
	const minutes = Math.max(1, Math.round(ms / 60_000));
	if (minutes < 60) return `${minutes} min`;
	if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h`;
	return `${Math.round(minutes / 1440)} days`;
}

/** The receipt text for a callsign that does not reach a running session. */
export function unreachableText(callsign: string, scope: string, target: Exclude<Target, { kind: "live" }>): string {
	if (target.kind === "offline") {
		return `${callsign} is offline (its session last ran ${formatAgo(Date.now() - target.lastRanAt)} ago). The callsign stays reserved for that session until it resumes or for ${RESERVE_MS / 86_400_000} days, so nothing else received this message.`;
	}
	return `Unknown peer "${callsign}" in collective "${scope}".${target.suggestions.length > 0 ? ` Did you mean: ${target.suggestions.join(", ")}?` : " Use the peers tool to list live sessions."}`;
}

/** One request/response round trip over a peer's socket. */
export function request(socketPath: string, frame: PeerFrame): Promise<PeerReply> {
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

/**
 * Deliver one frame to a running session. A live peer whose socket is missing or refusing is
 * re-binding (or will be within one check period), so wait for its socket to come back and
 * retry once rather than reporting a dead peer.
 */
export async function deliver(record: PeerRecord, frame: PeerFrame): Promise<PeerReply> {
	const first = await request(record.socket, frame);
	if (first.transport !== "ENOENT" && first.transport !== "ECONNREFUSED") return first;
	if (!pidAlive(record.pid)) return { ok: false, error: `${record.callsign} has exited` };
	const inode = (): number | undefined => {
		try {
			return fs.statSync(record.socket).ino;
		} catch {
			return undefined;
		}
	};
	const before = inode();
	const deadline = Date.now() + HEAL_WAIT_MS;
	while (Date.now() < deadline) {
		const { promise: tick, resolve: wake } = Promise.withResolvers<void>();
		setTimeout(wake, 250);
		await tick;
		const now = inode();
		if (now !== undefined && now !== before) return request(record.socket, frame);
	}
	return {
		ok: false,
		error: `${record.callsign} is running but its socket did not come back within ${HEAL_WAIT_MS / 1000} s (it may be suspended, or on agent-collective older than 0.4)`,
	};
}

/** One message this session sent or received. */
export interface LogEntry {
	at: number;
	dir: "in" | "out";
	/** The other side: a callsign, or a human sender's label. */
	peer: string;
	hop: number;
	/** Out: woken, aside, steered, coalesced, refused, offline, unknown, failed. */
	outcome?: string;
	body: string;
	/**
	 * A person typed it, not an agent. In: the sender was a person (CLI, Tern), not a session.
	 * Out: this session's user sent it from /collective, so the agent never saw it.
	 */
	human?: boolean;
}

export function logPath(dir: string, sessionId: string): string {
	return path.join(dir, "sessions", `${sessionId}.log.jsonl`);
}

/** This session's message log, oldest first; optionally only the exchange with `peer`. */
export function readLog(dir: string, sessionId: string, peer?: string): LogEntry[] {
	let text: string;
	try {
		text = fs.readFileSync(logPath(dir, sessionId), "utf8");
	} catch {
		return [];
	}
	const entries: LogEntry[] = [];
	for (const line of text.split("\n")) {
		if (!line) continue;
		try {
			const entry = JSON.parse(line) as LogEntry;
			if (typeof entry.at === "number" && (peer === undefined || entry.peer === peer)) entries.push(entry);
		} catch {
			// A torn last line from a crash; skip it.
		}
	}
	return entries;
}

/** Append one message, keeping the last LOG_KEEP. Messages are rare, so a rewrite is cheap. */
export function appendLog(dir: string, sessionId: string, entry: LogEntry): void {
	const file = logPath(dir, sessionId);
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const kept = readLog(dir, sessionId).slice(-(LOG_KEEP - 1));
	kept.push(entry);
	const temporary = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, `${kept.map(line => JSON.stringify(line)).join("\n")}\n`, { mode: 0o600 });
	fs.renameSync(temporary, file);
}
