#!/usr/bin/env node
/**
 * agent-collective CLI: read a collective and message its sessions from outside any session
 * (a shell, the Tern block). The package ships it built to `dist/agent-collective.js`
 * (`npm run build`, run on pack), which runs under node ≥22 or bun: node does not strip
 * types under node_modules. From a checkout, this file runs under bun or node ≥22.18.
 *
 *   agent-collective list   [--profile P] [--json]
 *   agent-collective send   [--profile P] [--from LABEL] <callsign> <message…>
 *   agent-collective thread [--profile P] --session <id> [--peer <callsign>] [--json]
 *
 * Exit codes: 0 done, 1 failure, 2 unknown or offline peer / bad usage.
 */
import {
	cleanProfile,
	collectiveDir,
	deliver,
	formatAgo,
	listCollective,
	readLog,
	resolveScope,
	resolveTarget,
	unreachableText,
	type CollectiveEntry,
} from "../store.ts";

const USAGE = `usage:
  agent-collective list   [--profile P] [--json]
  agent-collective send   [--profile P] [--from LABEL] <callsign> <message…>
  agent-collective thread [--profile P] --session <id> [--peer <callsign>] [--json]`;

function parse(argv: string[]): { command: string; flags: Record<string, string | true>; rest: string[] } {
	const [command = "", ...args] = argv;
	const flags: Record<string, string | true> = {};
	const rest: string[] = [];
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]!;
		if (arg === "--") {
			rest.push(...args.slice(i + 1));
			break;
		}
		if (arg === "--json") flags.json = true;
		else if (arg.startsWith("--")) {
			const [key, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
			const value = inline ?? args[i + 1];
			if (value === undefined) throw new Error(`--${key} needs a value`);
			flags[key] = value;
			if (inline === undefined) i += 1;
		} else rest.push(arg);
	}
	return { command, flags, rest };
}

function fail(message: string, code: number): never {
	process.stderr.write(`${message}\n`);
	process.exit(code);
}

/** JSON view of an entry: everything but the raw record, which is an internal detail. */
function publicEntry(entry: CollectiveEntry): Omit<CollectiveEntry, "record"> {
	const { record: _record, ...rest } = entry;
	return rest;
}

async function main(): Promise<void> {
	let parsed: ReturnType<typeof parse>;
	try {
		parsed = parse(process.argv.slice(2));
	} catch (error) {
		fail(`${(error as Error).message}\n${USAGE}`, 2);
	}
	const { command, flags, rest } = parsed;
	const rawProfile = typeof flags.profile === "string" ? flags.profile : undefined;
	const profile = rawProfile === undefined ? resolveScope() : cleanProfile(rawProfile);
	if (profile === undefined) fail(`invalid profile "${rawProfile}"`, 2);
	const dir = collectiveDir(profile);

	if (command === "list") {
		// A CLI is no session of its own, so nobody is excluded as "self".
		const entries = listCollective(dir, -1);
		if (flags.json) {
			process.stdout.write(`${JSON.stringify({ profile, sessions: entries.map(publicEntry) })}\n`);
			return;
		}
		if (entries.length === 0) {
			process.stdout.write(`collective "${profile}": no sessions\n`);
			return;
		}
		for (const entry of entries) {
			const age = entry.state === "offline" ? `last ran ${formatAgo(Date.now() - (entry.lastRanAt ?? Date.now()))} ago` : (entry.cwd ?? "");
			process.stdout.write(`${entry.callsign.padEnd(24)} ${entry.state.padEnd(8)} ${(entry.via ?? "").padEnd(3)} ${age}\n`);
		}
		return;
	}

	if (command === "send") {
		const [callsign, ...words] = rest;
		const body = words.join(" ").trim();
		if (!callsign || !body) fail(USAGE, 2);
		const to = callsign.replace(/^@/u, "");
		const from = typeof flags.from === "string" && flags.from.trim() ? flags.from.trim() : "you (via the agent-collective CLI)";
		const target = resolveTarget(dir, to, -1);
		if (target.kind !== "live") {
			process.stdout.write(`${unreachableText(to, profile, target)}\n`);
			process.exit(2);
		}
		if (!target.record.sessionId) fail(`${to} predates session binding; restart it.`, 2);
		const reply = await deliver(target.record, { t: "msg", from, to: target.record.sessionId, body, hop: 0, human: true });
		if (!reply.ok) {
			process.stdout.write(`Delivery to ${to} failed: ${reply.error ?? "unknown error"}\n`);
			process.exit(1);
		}
		process.stdout.write(`Delivered to ${to} (${reply.outcome ?? "injected"}).\n`);
		return;
	}

	if (command === "thread") {
		const session = typeof flags.session === "string" ? flags.session : undefined;
		if (!session || !/^[\w.-]+$/u.test(session)) fail(`thread needs --session <id>\n${USAGE}`, 2);
		const peer = typeof flags.peer === "string" ? flags.peer : undefined;
		const messages = readLog(dir, session, peer);
		if (flags.json) {
			process.stdout.write(`${JSON.stringify({ messages })}\n`);
			return;
		}
		for (const message of messages) {
			const arrow = message.dir === "out" ? `→ ${message.peer}` : `← ${message.peer}`;
			process.stdout.write(`${new Date(message.at).toISOString()} ${arrow}${message.outcome ? ` [${message.outcome}]` : ""}: ${message.body}\n`);
		}
		return;
	}

	fail(USAGE, command === "" || command === "help" || command === "--help" ? 0 : 2);
}

// `agent-collective list | head` closes the pipe early; that is not an error.
process.stdout.on("error", error => {
	if ((error as NodeJS.ErrnoException).code === "EPIPE") process.exit(0);
	throw error;
});
await main();
