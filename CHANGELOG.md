# Changelog

## 0.4.0

Breaking: records moved into per-profile directories, so 0.3.x and 0.4 sessions do not see each
other. Restart every session after upgrading.

- **Scoped by omp profile.** The registry is `~/.agent-collective/<profile>/`, from `OMP_PROFILE` /
  `PI_PROFILE` (`default` when unset; always `default` on pi). Profiles never see each other.
- **Fixed sessions becoming unreachable after sleep or a long stall.** Any peer whose heartbeat was
  more than 6 s old had its record *and socket* deleted by whichever peer looked first; the paused
  process kept listening on a deleted path and rewrote its record on resume, so it looked live but
  could never be reached. Now only a dead process's files are removed; each process checks its own
  socket every 5 s and re-binds it (temp path + atomic rename) if it is missing or replaced; and a
  sender waits up to 7 s for a live peer's socket to come back before failing.
- **Silent presence.** No 1.2 s heartbeat, no reading other records until a tool asks, no "joined" /
  "left" notifications. Records are written at start, on rename, and at turn start/end.
- **Need-to-know.** The roster is no longer injected into prompts. The footer chip shows only this
  session's contacts (peers it has messaged or heard from), persisted per session id. `peers` takes
  an optional `filter` and lists contacts first; `peer_send` accepts `@name`. Inbound messages name
  the recipient's own callsign.
- **One tool surface on omp and pi.** The omp `hub` bridge is gone: on omp 18.11 it registered peers
  in a module copy the host never reads, so it had silently fallen back to tools anyway, and its
  stub reported failed sends as delivered. omp sessions are labelled `omp` again (harness was
  derived from the bridge). A busy omp peer receives an aside; a busy pi peer a steer.
- `npm test`: acceptance suite with real processes and sockets — profile isolation, silence,
  contacts, aside delivery, hop guard, stall/resume, deleted-socket heal, dead-peer reaping.

## 0.3.2

- Fixed the hop guard refusing ordinary traffic in busy, long-running instances. The node kept one
  hop counter, set by the *last* inbound message and reset only by a typed human prompt, so a worker
  that received a late-chain reply kept stamping hop 5 on every later send — to any peer, in any
  later turn — until a human typed into it. Lineage is now scoped:
  - a message that steers into a running turn raises the hop only for replies to its sender;
  - only a message that wakes an idle agent roots that turn's hop for all its sends;
  - lineage clears when a turn ends (`agent_end`), not only on human input.
  Mutual wake is still bounded: each woken turn inherits the waking message's hop.
- The "relay hops remain" hint reflects the hop a reply to that sender would actually carry.
- Fixed the roster note breaking the provider prompt cache. It was re-rendered on every model call
  and appended to whichever user message was newest, so each new turn moved it off the previous
  prompt (re-prefilling that whole turn), and the per-peer `(working)`/`(idle)` flags flipping on
  the heartbeat changed the prompt between calls of one turn. Each user message now gets its note
  — or none — on the first call that sends it, and the same bytes on every later call; a new note
  is attached only to a new user message, and only when the roster changed. Busy state left the
  note; `peers` and `hub op=list` report it on demand.

## 0.3.1

- Fixed `collective: not started`. The node was created only inside `session_start`, so any path
  where that handler did not run for the live session — the module loaded after the session began
  (an install plus `/reload-plugins`), or a session replaced inside the process — left the commands
  registered with nothing behind them until the process restarted. Every entry point now starts the
  node on demand: `session_start`, `session_switch` / `session_branch` / `session_tree`, the
  `context` event before each model call, and both commands.
- A failed start now reports the actual error instead of silently leaving the instance out of the
  collective.
- `/collective` names the active mode (`hub bridge` or `peer tools`) and each peer's harness.

## 0.3.0

- Mutual-wake guard. Every message carries a `hop` count — its distance from the human prompt that
  started the chain — and delivery is refused past 4 hops with an explicit "the chain ends here"
  error to the sender. Behavioural loops (A wakes B, B's turn wakes A) are legitimate single hops
  individually, so no transport-level check catches them; this is counted where messages are minted.
  A human prompt resets the count.
- Burst coalescing. Messages from one peer arriving within 400 ms become a single wake instead of one
  billed turn each, delivered as one numbered batch.
- Injected messages state how many relay hops remain, and say to answer the user rather than relay
  when the chain is on its last hop.

## 0.2.0

- Renamed to `agent-collective`: it is no longer omp-specific.

- Works on pi as well as omp. The host is probed at load: omp gets the native `hub` bridge, pi gets `peers`/`peer_send` tools and `sendUserMessage` delivery.
- One machine-global registry directory (`~/.agent-collective`) shared by both harnesses, so an omp instance and a pi instance peer with each other.
- Callsigns adopt a session name only when the host reports it as user-set; on hosts without a title source (pi), only address-shaped names are adopted.
- Roster rows and the footer chip name each peer's harness.

## 0.1.0

- Initial release: machine-global peer registry, callsign addressing via `/rename` and `/callsign`, `hub` bridge for cross-instance list/send/await, footer roster chip, per-call roster context, `/collective` roster command.
