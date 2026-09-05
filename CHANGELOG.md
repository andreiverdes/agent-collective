# Changelog

## 0.2.0

- Works on pi as well as omp. The host is probed at load: omp gets the native `hub` bridge, pi gets `peers`/`peer_send` tools and `sendUserMessage` delivery.
- One machine-global registry directory (`~/.agent-collective`) shared by both harnesses, so an omp instance and a pi instance peer with each other.
- Callsigns adopt a session name only when the host reports it as user-set; on hosts without a title source (pi), only address-shaped names are adopted.
- Roster rows and the footer chip name each peer's harness.

## 0.1.0

- Initial release: machine-global peer registry, callsign addressing via `/rename` and `/callsign`, `hub` bridge for cross-instance list/send/await, footer roster chip, per-call roster context, `/collective` roster command.
