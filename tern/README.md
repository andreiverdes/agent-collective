# Collective block for Tern

A [Tern](https://stencil.so) plugin that shows the sessions of an agent-collective profile in a
block: who is working, idle, quiet, waiting for input or offline, in which directory, and in which
Tern pane. Pick a session to read its thread, jump to its pane or message it from the composer.

## Install

```sh
tern plugin install github.com/andreiverdes/agent-collective/tern
```

For development, use the checkout in place:

```sh
tern plugin link <repo>/tern     # tern plugin unlink agent-collective to stop
tern plugin reload               # after editing host.luau, window.luau or style.css
```

The block runs the agent-collective CLI (`bin/agent-collective.ts`), so agent-collective itself
must be installed (`omp plugin install agent-collective`). It looks for the CLI in
`~/.omp/plugins/node_modules/agent-collective/bin/agent-collective.ts`, then beside a linked
checkout (`<repo>/bin`), and runs it with bun or Node 22.18+, found by absolute path (`~/.bun/bin`,
`/opt/homebrew/bin`, `/usr/local/bin`, `~/.volta/bin`, `~/.nvm`, then Tern's `PATH`). To point it
elsewhere, use the palette's **Collective: Set CLI path…** and **Collective: Set runtime…** (an
empty value goes back to looking it up), or set `AGENT_COLLECTIVE_CLI` / `AGENT_COLLECTIVE_RUNTIME`
in the environment Tern's daemon starts with.

## Open it

Command palette (⌘K) → **New Collective block**. It opens beside the focused pane and remembers its
profile, filter and selection across restarts.

## What it shows

- **Header**: the profile and how many sessions it has; it refreshes every 2 seconds from
  `agent-collective list --json`.
- **Profiles**: when `~/.agent-collective/` holds more than one profile, a row of tabs picks one. A
  new block starts on the profile of the session in the pane you were in, else `default`.
- **Filters**: All, This window (sessions whose Tern pane is in this window), Working, Offline.
  ⇥ / ⇧⇥ cycle them.
- **Sessions**: callsign, state (working, idle, quiet for how long, waiting input when the agent's
  pane is waiting for you, offline for how long; offline rows are dimmed), directory, and pane: the
  tab's position in this window (`3`, or `3.2` for the second pane of a split tab), `tern` for a
  Tern pane elsewhere, `herdr` or `tty` for sessions outside Tern. ↑ / ↓ or a click selects.
- **Detail card** of the selected session: harness and model, directory, turn state, and the last
  message in its log. **Go to pane** focuses its Tern pane (⌘↵ does the same; disabled for sessions
  outside Tern), **Thread** shows its message log over the block (Esc closes it), **Copy callsign**.
- **Composer**: type and press Enter to send the selected session a message with
  `agent-collective send --profile <profile> <callsign> <message>`. It arrives from
  `you (via Tern)`, hop 0, and the receipt shows as a toast. Esc clears the draft.

A session shows its Tern pane once it runs an agent-collective release that reports it
(`where.tern.pane` in `list --json`, the same release as this block); older sessions show `—`.
