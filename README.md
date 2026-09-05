# omp-hive

Cross-instance peer awareness and steering for [omp](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent).

Every running omp instance announces itself, sees the others by **callsign**, and can prompt them
through the **built-in `hub` tool** — no new tool to learn:

```
hub op=list                      → other terminals listed next to your local subagents
hub op=send to="007" ...         → a real prompt injected into that terminal's agent
                                   its reply comes back to you as a peer message
hub op=send to="007" await=true  → resolves in-band with the reply
```

Works across project directories on one machine.

## Install

```sh
omp plugin install omp-hive
```

Restart each omp instance you want in the hive (extensions load at session start).

## Use

| Input                | Effect                                                                       |
| -------------------- | ---------------------------------------------------------------------------- |
| `/rename 007`        | Renames the session; hive adopts `007` as the callsign                        |
| `/callsign 007`      | Sets the callsign only, leaving the session title alone                       |
| `/hive`              | Lists live instances (callsign, pid, cwd, working state)                      |
| `hub op=list`        | Same peers, as addressable agents, alongside local subagents                  |
| `hub op=send to=…`   | Steer a peer; `await=true` waits for its reply                                |

The footer carries a roster chip — `⇄ 007 goose-3182* +2` — where `*` marks a working peer,
working peers and peers sharing your cwd sort first, and the rest collapse into `+N`.

Every model call also carries a short roster block naming your own callsign and the live peers, so
an agent can address them without being told they exist.

### Callsigns

Resolution order: `/callsign` override → session name **if user-set** (`/rename`, RPC) →
`<project>-<pid>`.

Auto-generated session titles are deliberately ignored. A callsign is an address, and auto titles
are model-written sentences that also get rewritten on replan (`title.refreshOnReplan`), which would
rename an instance — and break every peer's addressing — mid-session.

Name collisions deconflict by start time: the older instance keeps the bare name, the younger gets a
`-<pid>` suffix.

## How it works

- Each process writes `~/.omp/run/hive/<pid>.json` (0600, 1.2 s heartbeat) and listens on
  `<pid>.sock` in the same directory. Liveness is `process.kill(pid, 0)` plus a stale-beat reap,
  matching omp's own presence conventions. Records and sockets are unlinked on session shutdown.
- Every other live instance is registered in this process's `AgentRegistry` as a ref whose session
  is a stub forwarding `deliverIrcMessage` over that peer's socket. `hub` resolves names against
  exactly that registry, so remote instances become addressable with no changes to the tool.
- Inbound messages are handed to the local agent through the host's own `hub` send path, so a peer's
  `await=true` is satisfied by the bus waiter rather than timing out, and the message renders as a
  normal peer message carrying the reply protocol.
- The roster is injected via the `context` event (before every model call, on a clone that never
  reaches the transcript), appended to the last user message so provider role alternation and the
  cached prompt prefix stay intact.

## Limits

- **Same machine only.** Unix sockets, one shared directory. For remote pairing use `/collab`.
- **Depends on omp internals.** It imports `@oh-my-pi/pi-coding-agent/registry/agent-registry` and
  `/tools/hub/messaging` — real host singletons, but not a stable extension API. An omp upgrade can
  break it; the failure mode is a load error naming the specifier. Peer range is declared in
  `peerDependencies`.
- **`hub op=send to="all"` now leaves the process** — broadcast reaches other terminals too.
- **Agent Hub (`Alt+A`) lists hive peers** as `sub` rows. Their session is a forwarding stub, so
  read and steer them via `hub` or `/hive` rather than focusing the row.
- A callsign equal to a local agent id (e.g. a subagent name, or `Main`) is skipped with a warning
  rather than shadowing the local peer.
- Roster injection costs roughly one line per peer per model call; with no peers nothing is injected
  and no status chip is shown.

## License

MIT
