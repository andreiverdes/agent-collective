# Changelog

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
