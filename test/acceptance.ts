// Acceptance suite: real processes, real unix sockets, isolated HOME. Run with `npm test`.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const EXT = path.resolve(import.meta.dir, "../index.ts");
const HOST = path.resolve(import.meta.dir, "host.ts");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "collective-test-"));
type Ev = { ev: string; [k: string]: unknown };
type Proc = { p: ReturnType<typeof Bun.spawn>; evs: Ev[]; pid: number };
const procs: Record<string, Proc> = {};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (ok: boolean, label: string, extra = "") => {
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
};
async function spawn(name: string, env: Record<string, string> = {}) {
	// --no-install: otherwise bun tries to auto-install the host packages and hangs.
	const p = Bun.spawn(["bun", "--no-install", HOST], {
		env: { ...process.env, OMP_PROFILE: "", PI_PROFILE: "", HOME: home, NAME: name, EXT, ...env },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "inherit",
	});
	const entry: Proc = { p, evs: [], pid: p.pid };
	procs[name] = entry;
	(async () => {
		let buf = "";
		for await (const c of p.stdout as ReadableStream<Uint8Array>) {
			buf += new TextDecoder().decode(c);
			let i: number;
			while ((i = buf.indexOf("\n")) !== -1) {
				entry.evs.push(JSON.parse(buf.slice(0, i)));
				buf = buf.slice(i + 1);
			}
		}
	})();
	while (!entry.evs.some(e => e.ev === "ready")) await sleep(20);
	await sleep(100);
}
const cmd = (n: string, o: object) => (procs[n]!.p.stdin as import("bun").FileSink).write(`${JSON.stringify(o)}\n`);
let seq = 0;
async function tool(from: string, name: string, params: object): Promise<string> {
	const id = ++seq;
	cmd(from, { cmd: "tool", name, params, id });
	for (;;) {
		const hit = procs[from]!.evs.find(e => e.ev === "tool" && e.id === id);
		if (hit) return String(hit.text);
		await sleep(20);
	}
}
const evs = (n: string, kind: string) => procs[n]!.evs.filter(e => e.ev === kind);

// 1. Profile scoping
await spawn("alpha", { HOST: "omp" });
await spawn("beta", { HOST: "pi" });
await spawn("gamma", { HOST: "omp", OMP_PROFILE: "greenely", PI_PROFILE: "greenely" });
const alphaPeers = await tool("alpha", "peers", {});
check(alphaPeers.includes("`beta`") && !alphaPeers.includes("gamma"), "default profile sees beta, not greenely gamma", alphaPeers.split("\n")[0]);
const gammaPeers = await tool("gamma", "peers", {});
check(gammaPeers.includes("No peers") && gammaPeers.includes('"greenely"'), "greenely gamma sees nobody");
check((await tool("alpha", "peer_send", { to: "gamma", message: "x" })).startsWith("Unknown peer"), "cross-profile send is refused");
check(fs.existsSync(path.join(home, ".agent-collective/default")) && fs.existsSync(path.join(home, ".agent-collective/greenely")), "registry dirs are per profile");

// 2. Silence: no join/leave notifications, no status chip before any contact
await spawn("delta", { HOST: "pi" });
procs.delta!.p.kill();
await sleep(300);
const noisy = ["alpha", "beta", "gamma"].flatMap(n => evs(n, "notify"));
check(noisy.length === 0, "no notifications when sessions join or leave", JSON.stringify(noisy));
check(evs("alpha", "status").every(e => e.t === undefined), "no status chip before any contact");

// 3. Need-to-know contacts + harness labels
const sent = await tool("alpha", "peer_send", { to: "@beta", message: "hello from alpha" });
await sleep(700);
check(sent.startsWith("Delivered to beta (woken)"), "alpha → @beta delivered", sent);
const inbound = evs("beta", "inbound")[0];
check(String(inbound?.text ?? "").includes("to you (`beta`)"), "inbound names the recipient's own callsign");
check(evs("alpha", "status").at(-1)?.t === "⇄ beta" && evs("beta", "status").at(-1)?.t === "⇄ alpha", "both sides now show only each other as contacts");
check(alphaPeers.includes("`beta` — pi") && (await tool("beta", "peers", {})).includes("`alpha` — omp"), "harness labels: omp vs pi");
const contactsFile = path.join(home, ".agent-collective/default/contacts/sess-alpha.json");
check(fs.existsSync(contactsFile) && fs.readFileSync(contactsFile, "utf8").includes("beta"), "contacts persisted per session");
cmd("beta", { cmd: "end" });

// 4. Busy alpha receives an omp aside, not a wake
cmd("alpha", { cmd: "input" });
await sleep(100);
await tool("beta", "peer_send", { to: "alpha", message: "reply while you work" });
await sleep(700);
check(evs("alpha", "inbound").at(-1)?.deliverAs === "aside", "busy omp peer gets an aside");
const busyView = await tool("beta", "peers", {});
check(busyView.includes("`alpha` — omp in /tmp/alpha (working"), "busy state comes from agent_start, read on demand");
cmd("alpha", { cmd: "end" });
await sleep(100);

// 4b. Hop guard: mutual wake refused on the 6th send; a mid-turn steer does not tax unrelated sends
await spawn("eps", { HOST: "pi" });
cmd("alpha", { cmd: "input" });
let [from, to] = ["alpha", "beta"];
const results: string[] = [];
for (let i = 0; i < 7; i++) {
	const r = await tool(from, "peer_send", { to, message: `ping ${i}` });
	results.push(r.slice(0, 12));
	cmd(from, { cmd: "end" });
	if (!r.startsWith("Delivered")) break;
	await sleep(600);
	[from, to] = [to, from];
}
check(results.length === 6 && results[5]!.startsWith("Delivery to"), "mutual wake refused on the 6th send", results.join(" | "));
for (const n of ["alpha", "beta"]) cmd(n, { cmd: "end" });
await sleep(100);
cmd("eps", { cmd: "input" });
await sleep(100);
await new Promise<void>(resolve => {
	const s = net.createConnection(path.join(home, `.agent-collective/default/${procs.eps!.pid}.sock`));
	s.on("connect", () => s.write(`${JSON.stringify({ t: "msg", from: "beta", body: "late", hop: 4 })}\n`));
	s.on("data", () => { s.destroy(); resolve(); });
});
check((await tool("eps", "peer_send", { to: "alpha", message: "unrelated" })).startsWith("Delivered"), "steered-by-hop-4 worker can still message an unrelated peer");
check((await tool("eps", "peer_send", { to: "beta", message: "answer" })).includes("Refused"), "but its answer to the hop-4 sender is refused");
cmd("eps", { cmd: "end" });
cmd("alpha", { cmd: "end" });
await sleep(700);

// 5. Socket loss: SIGSTOP longer than the old 6 s stale window, then resume
const sock = path.join(home, `.agent-collective/default/${procs.beta!.pid}.sock`);
process.kill(procs.beta!.pid, "SIGSTOP");
await sleep(8000);
await tool("alpha", "peers", {}); // old code reaped here
check(fs.existsSync(sock), "stalled peer's socket is not reaped by others");
process.kill(procs.beta!.pid, "SIGCONT");
await sleep(300);
const afterStall = await tool("alpha", "peer_send", { to: "beta", message: "after stall" });
check(afterStall.startsWith("Delivered"), "stalled peer reachable after resume", afterStall);

// 6. Socket file deleted outright (e.g. tmp cleaner): owner re-binds, sender waits and retries
fs.rmSync(sock);
const t0 = Date.now();
const afterDelete = await tool("alpha", "peer_send", { to: "beta", message: "after delete" });
check(afterDelete.startsWith("Delivered") && fs.existsSync(sock), "deleted socket heals and the send succeeds", `${afterDelete.slice(0, 40)} in ${Date.now() - t0} ms`);
cmd("beta", { cmd: "end" });
await sleep(100);

// 7. Dead peer gets reaped
const betaPid = procs.beta!.pid;
procs.beta!.p.kill("SIGKILL");
await sleep(200);
const deadSend = await tool("alpha", "peer_send", { to: "beta", message: "anyone?" });
check(deadSend.startsWith("Unknown peer") && !fs.existsSync(path.join(home, `.agent-collective/default/${betaPid}.json`)), "killed peer is reaped on the next read");

// 8. Idle instance does no polling of others: count fs reads via record mtimes is indirect; check no record rewrite storm
const rec = path.join(home, `.agent-collective/default/${procs.alpha!.pid}.json`);
const m1 = fs.statSync(rec).mtimeMs;
await sleep(6000);
check(fs.statSync(rec).mtimeMs === m1, "idle record not rewritten every few seconds");

for (const { p } of Object.values(procs)) p.kill();
fs.rmSync(home, { recursive: true, force: true });
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
