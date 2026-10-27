// Fake host: loads the extension, drives events/tools/commands from stdin JSON lines, logs every
// UI/prompt effect. NAME labels the process; SESSION_NAME (default NAME, empty = unnamed), CWD and
// SESSION_ID override what the host reports. AGENT_KIND=sub makes the context a task subagent, as
// omp reports one that shares the parent's process. `switch` swaps the session in-process the way
// omp's `/resume` does: a new session id and `session_switch`, with no `session_shutdown`.
// The extension path is runtime-selected (EXT), so this import cannot be static.
const ext = (await import(process.env.EXT!)).default;
const handlers = new Map<string, ((e: unknown, c: unknown) => unknown)[]>();
const tools = new Map<
	string,
	{
		execute: (id: string, p: Record<string, unknown>, s?: AbortSignal, u?: unknown, c?: unknown) => Promise<{ content: { text: string }[] }>;
	}
>();
const commands = new Map<string, (args: string, c: unknown) => Promise<void>>();
let idle = true;
const out = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);
const omp = process.env.HOST === "omp";
const sessionName = process.env.SESSION_NAME ?? process.env.NAME;
const agentKind = process.env.AGENT_KIND === "sub" ? "sub" : "main";
let sessionId = process.env.SESSION_ID ?? `sess-${process.env.NAME}`;
type View = { render(width: number): string[]; handleInput?(data: string): void; dispose?(): void };
let view: View | undefined;
// A plain theme, so rendered lines can be asserted as text.
const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t };
const tui = { requestRender: () => undefined, terminal: { rows: Number(process.env.ROWS ?? 30), columns: 140 } };
const custom = async (factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: unknown) => void) => View | Promise<View>) => {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	view = await factory(tui, theme, {}, result => {
		view?.dispose?.();
		view = undefined;
		resolve(result);
	});
	return promise;
};
const ctx = {
	cwd: process.env.CWD ?? `/tmp/${process.env.NAME}`,
	agent: { kind: agentKind, id: process.env.NAME!, name: agentKind === "sub" ? "task" : "main", depth: agentKind === "sub" ? 1 : 0 },
	ui: { notify: (m: string) => out({ ev: "notify", m }), setStatus: (k: string, t?: string) => out({ ev: "status", t }), custom },
	isIdle: () => idle,
	sessionManager: { getSessionId: () => sessionId, getHeader: () => ({ titleSource: "user" }) },
	...(omp ? { setInterval: (f: () => void, ms: number) => setInterval(f, ms), clearTimer: (t: ReturnType<typeof setInterval>) => clearInterval(t) } : {}),
};
const subCtx = {
	...ctx,
	agent: { kind: "sub" as const, id: `${process.env.NAME}-sub`, name: "task", depth: 1 },
	sessionManager: { getSessionId: () => `sess-${process.env.NAME}-sub`, getHeader: () => ({ titleSource: "user" }) },
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
const fire = async (e: string, payload: unknown, targetCtx: unknown = ctx) => {
	for (const h of handlers.get(e) ?? []) await h(payload, targetCtx);
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
		else if (cmd.cmd === "sub-start") {
			await fire("session_start", {}, subCtx);
			await fire("input", { source: "interactive" }, subCtx);
			await fire("agent_start", {}, subCtx);
			out({ ev: "sub-started", id: cmd.id });
		} else if (cmd.cmd === "sub-end") {
			await fire("agent_end", {}, subCtx);
			await fire("session_shutdown", {}, subCtx);
			out({ ev: "sub-ended", id: cmd.id });
		} else if (cmd.cmd === "tool") {
			const r = await tools.get(cmd.name)!.execute("x", cmd.params, undefined, undefined, cmd.sub ? subCtx : ctx);
			out({ ev: "tool", id: cmd.id, text: r.content[0]!.text });
		} else if (cmd.cmd === "command") {
			await commands.get(cmd.name)!(cmd.args, ctx);
			out({ ev: "command", id: cmd.id });
		} else if (cmd.cmd === "switch") {
			sessionId = cmd.sessionId;
			await fire("session_switch", { reason: "resume" });
			out({ ev: "switched", id: cmd.id });
		} else if (cmd.cmd === "exit") {
			await fire("session_shutdown", {});
			process.exit(0);
		} else if (cmd.cmd === "tui-open") {
			// The command resolves only when the overlay closes, so it is not awaited here.
			void commands.get("collective")!("", ctx).then(() => out({ ev: "tui-closed" }));
			while (!view) await new Promise(r => setTimeout(r, 10));
			out({ ev: "tui", id: cmd.id, lines: view.render(cmd.width ?? 140) });
		} else if (cmd.cmd === "tui-keys") {
			view?.handleInput?.(cmd.data);
			// Sends and focus run async; give them a moment before rendering.
			await new Promise(r => setTimeout(r, cmd.settle ?? 50));
			out({ ev: "tui", id: cmd.id, lines: view ? view.render(cmd.width ?? 140) : [] });
		}
	}
}
