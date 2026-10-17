// Fake host: loads the extension, drives events/tools from stdin JSON lines, logs every UI/prompt effect.
const ext = (await import(process.env.EXT!)).default;
const handlers = new Map<string, ((e: unknown, c: unknown) => unknown)[]>();
const tools = new Map<string, { execute: (id: string, p: Record<string, unknown>) => Promise<{ content: { text: string }[] }> }>();
let idle = true;
const out = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);
const omp = process.env.HOST === "omp";
const ctx = {
	cwd: `/tmp/${process.env.NAME}`,
	ui: { notify: (m: string) => out({ ev: "notify", m }), setStatus: (k: string, t?: string) => out({ ev: "status", t }) },
	isIdle: () => idle,
	sessionManager: { getSessionId: () => `sess-${process.env.NAME}`, getHeader: () => ({ titleSource: "user" }) },
	...(omp ? { setInterval: (f: () => void, ms: number) => setInterval(f, ms), clearTimer: (t: ReturnType<typeof setInterval>) => clearInterval(t) } : {}),
};
const pi = {
	on: (e: string, h: (e: unknown, c: unknown) => unknown) => handlers.set(e, [...(handlers.get(e) ?? []), h]),
	registerCommand() {},
	registerTool: (t: { name: string }) => tools.set(t.name, t as never),
	getSessionName: () => process.env.NAME,
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
		}
	}
}
