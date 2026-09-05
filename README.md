# agent-collective

Cross-instance peer awareness and steering for [omp](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent)
**and [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)**.

Every running instance announces itself, sees the others by **callsign**, and can prompt them. One
machine-global registry is shared by both harnesses, so an omp terminal and a pi terminal peer with
each other.

**On omp** it needs no new tool — peers are bridged into the same registry the built-in `hub` tool
resolves names against:

```
hub op=list                      → other terminals listed next to your local subagents
hub op=send to="007" ...         → a real prompt injected into that terminal's agent
hub op=send to="007" await=true  → resolves in-band with the reply
```

**On pi** there is no IRC bus, no agent registry and no `hub` tool, and the package exports only
`.` and `./rpc-entry`, so there is nothing to bridge. Two tools are registered instead:

```
peers                            → list live instances by callsign
peer_send to="007" message="…"   → prompt that instance; its reply arrives as a peer message
```

The host is probed once at load, so one file serves both.

## Install

omp:

```sh
omp plugin install agent-collective
```

pi:

```sh
pi install npm:agent-collective
```

Restart each instance you want in the collective (extensions load at session start).

This repo also ships `.omp-plugin/marketplace.json`, so it works as an omp marketplace source:

```sh
omp plugin marketplace add andreiverdes/agent-collective
omp plugin install agent-collective@agent-collective
```

Install it **one way only**. Two copies loaded in one process (for example an npm install plus a
loose `~/.omp/agent/extensions/collective.ts`) means two collective nodes per instance: two records,
two sockets, and peer refs claimed twice.

## Use

| Input                          | Effect                                                                    |
| ------------------------------ | ------------------------------------------------------------------------- |
| `/rename 007`                  | Renames the session; the collective adopts `007` as the callsign          |
| `/callsign 007`                | Sets the callsign only, leaving the session title alone                   |
| `/collective`                  | Lists live instances (callsign, harness, pid, cwd, working state)         |
| `hub op=list` / `op=send`      | omp: peers as addressable agents; `await=true` waits for the reply        |
| `peers` / `peer_send`          | pi: the same two operations as tools                                      |

The footer carries a roster chip — `⇄ 007 goose-3182* +2` — where `*` marks a working peer,
working peers and peers sharing your cwd sort first, and the rest collapse into `+N`.

Every model call also carries a short roster block naming your own callsign, each peer's harness,
and how to reach them, so an agent can address peers without being told they exist.

### Callsigns

Resolution order: `/callsign` override → the session name, when it is safe to adopt →
`<project>-<pid>`.

"Safe to adopt" means the host reports the title as user-set (`/rename`, RPC). A callsign is an
address, and an auto-generated title is a model-written sentence that `title.refreshOnReplan`
rewrites mid-session — adopting it would rename an instance and break every peer's addressing. pi
exposes no title source, so there a session name is adopted only when it already looks like an
address: one token, no whitespace, within the length cap.

Name collisions deconflict by start time: the older instance keeps the bare name, the younger gets a
`-<pid>` suffix.

## How it works

- Each process writes `~/.agent-collective/<pid>.json` (0600, 1.2 s heartbeat) and listens on
  `<pid>.sock` beside it. Liveness is `process.kill(pid, 0)` plus a stale-beat reap, matching omp's
  own presence conventions. Records and sockets are unlinked on session shutdown. The directory is
  deliberately not derived from any env var — two terminals with different environments must never
  end up in two separate collectives.
- The host is probed once during module evaluation (top-level await), because tool registration is
  load-time only:
  - **omp** — `registry/agent-registry` and `tools/hub/messaging` resolve, so each peer becomes a
    registry ref whose session is a stub forwarding `deliverIrcMessage` over that peer's socket.
    `hub` resolves names against exactly that registry, so peers are addressable with no change to
    the tool. Inbound goes through the host's own `hub` send path, so a peer's `await=true` is
    satisfied by the bus waiter instead of timing out.
  - **pi** — neither module exists, so `peers` / `peer_send` are registered and inbound arrives via
    `sendUserMessage`.
- The roster is injected on the `context` event (before every model call, on a clone that never
  reaches the transcript), appended to the last user message so provider role alternation and the
  cached prompt prefix stay intact.

## Limits

- **Same machine only.** Unix sockets, one shared directory. For remote pairing use omp's `/collab`.
- **Depends on omp internals for bridge mode.** It imports
  `@oh-my-pi/pi-coding-agent/registry/agent-registry` and `/tools/hub/messaging` — real host
  singletons, but not a stable extension API. If an omp upgrade removes them from the bundled export
  map, the probe fails and the extension silently degrades to tool mode on omp too.
- **`hub op=send to="all"` leaves the process** on omp — broadcast reaches other terminals.
- **Mid-turn delivery differs.** omp injects an aside that does not interrupt a running tool batch.
  pi has no aside, so a message arriving mid-turn steers and does interrupt.
- **Agent Hub (`Alt+A`) lists collective peers** as `sub` rows on omp. Their session is a forwarding
  stub, so read and steer them via `hub` or `/collective` rather than focusing the row.
- A callsign equal to a local agent id (a subagent name, or `Main`) is skipped with a warning rather
  than shadowing the local peer.
- **No mutual-wake guard yet.** Two peers that wake each other will keep doing so; nothing counts
  hops or coalesces pending wakes. Each wake is a billed turn in an unwatched session.
- Roster injection costs roughly one line per peer per model call; with no peers nothing is injected
  and no status chip is shown.

## License

MIT
