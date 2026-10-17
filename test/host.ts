// Fake host: loads the extension, drives events/tools/commands from stdin JSON lines, logs every
// UI/prompt effect. NAME labels the process; SESSION_NAME (default NAME, empty = unnamed), CWD and
// SESSION_ID override what the host reports.
// The extension path is runtime-selected (EXT), so this import cannot be static.
const ext = (await import(process.env.EXT!)).default;
const handlers = new Map<string, ((e: unknown, c: unknown) => unknown)[]>();
const tools = new Map<string, { execute: (id: string, p: Record<string, unknown>) => Promise<{ content: { text: string }[] }> }>();
const commands = new Map<string, (args: string, c: unknown) => Promise<void>>();
let idle = true;
const out = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);
const omp = process.env.HOST === "omp";
const sessionName = process.env.SESSION_NAME ?? process.env.NAME;
const ctx = {
	cwd: process.env.CWD ?? `/tmp/${process.env.NAME}`,
	ui: { notify: (m: string) => out({ ev: "notify", m }), setStatus: (k: string, t?: string) => out({ ev: "status", t }) },
	isIdle: () => idle,
	sessionManager: { getSessionId: () => process.env.SESSION_ID ?? `sess-${process.env.NAME}`, getHeader: () => ({ titleSource: "user" }) },
	...(omp ? { setInterval: (f: () => void, ms: number) => setInterval(f, ms), clearTimer: (t: ReturnType<typeof setInterval>) => clearInterval(t) } : {}),
};
const pi = {
	on: (e: string, h: (e: unknown, c: unknown) => unknown) => handlers.set(e, [...(handlers.get(e) ?? []), h]),
	registerCommand: (name: string, o: { handler: (args: string, c: unknown) => Promise<void> }) => commands.set(name, o.handler),
	registerTool: (t: { name: string }) => tools.set(t.name, t as never),
	getSessionName: () => (sessionName ? sessionName : undefined),
	sendUserMessage: (text: string, opts?: { deliverAs?: string }) => {
		if (!opts) idle = false;
		out({ ev: "inbound", deliverAs: opts?.deliverAs ?? "wake", text });
	},
};
ext(pi);
const fire = async (e: string, payload: unknown) => {
	for (const h of handlers.get(e) ?? []) await h(payload, ctx);
};
await fire("session_start", {});
out({ ev: "ready", pid: process.pid });
let buf = "";
for await (const chunk of process.stdin) {
	buf += String(chunk);
	let i: number;
	while ((i = buf.indexOf("\n")) !== -1) {
		const cmd = JSON.parse(buf.slice(0, i));
		buf = buf.slice(i + 1);
		if (cmd.cmd === "input") { idle = false; await fire("input", { source: "interactive" }); await fire("agent_start", {}); }
		else if (cmd.cmd === "end") { idle = true; await fire("agent_end", {}); }
		else if (cmd.cmd === "tool") {
			const r = await tools.get(cmd.name)!.execute("x", cmd.params);
			out({ ev: "tool", id: cmd.id, text: r.content[0]!.text });
		} else if (cmd.cmd === "command") {
			await commands.get(cmd.name)!(cmd.args, ctx);
			out({ ev: "command", id: cmd.id });
		} else if (cmd.cmd === "exit") {
			await fire("session_shutdown", {});
			process.exit(0);
		}
	}
}
