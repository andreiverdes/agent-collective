# agent-collective

Peer messaging between [omp](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent) and
[pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) sessions on one machine.

Ask one session to talk to another — "ask @be-audio whether the migration landed" — and it does:

```
peers filter="audio"               → find the exact callsign
peer_send to="be-audio" message="…" → a real prompt in that session; its reply arrives here
```

Three rules:

- **Scoped by omp profile.** Sessions started with `omp --profile greenely` form their own
  collective; they never see sessions in the default profile, and vice versa. pi has no profiles,
  so pi sessions join `default`.
- **Silent.** Starting or closing a session notifies nobody. Nothing is added to prompts. A session
  finds out who is online only when it asks (`peers`, `/collective`).
- **Need-to-know.** A session's contacts are the peers it has messaged or heard from. Only those show
  in its footer chip, and they are remembered per session across resume.

## Install

omp:

```sh
omp plugin install agent-collective
omp --profile <name> plugin install agent-collective   # once per extra profile
```

pi:

```sh
pi install npm:agent-collective
```

Restart each session you want reachable (extensions load at session start).

This repo also ships `.omp-plugin/marketplace.json`, so it works as an omp marketplace source:

```sh
omp plugin marketplace add andreiverdes/agent-collective
omp plugin install agent-collective@agent-collective
```

Install it **one way only**. Two copies loaded in one process means two nodes per session: two
records and two sockets.

## Use

| Input                         | Effect                                                                     |
| ----------------------------- | -------------------------------------------------------------------------- |
| `/rename 007`                 | Renames the session; the collective adopts `007` as the callsign           |
| `/callsign 007`               | Sets the callsign only, leaving the session title alone                    |
| `/collective`                 | Lists live sessions in this collective; contacts are starred               |
| `peers` (tool)                | Same list for the agent, optional `filter`; contacts first                 |
| `peer_send` (tool)            | Prompt a session by callsign (`@name` accepted); the reply arrives as a peer message |

An idle peer wakes into a turn. A busy omp peer receives the message as an aside, which does not
interrupt its running tool batch; a busy pi peer is steered (pi has no aside).

### Callsigns

Resolution order: `/callsign` override → the session name, when it is safe to adopt →
`<project>-<pid>`.

"Safe to adopt" means the host reports the title as user-set (`/rename`, RPC). A callsign is an
address, and an auto-generated title is a model-written sentence that `title.refreshOnReplan`
rewrites mid-session — adopting it would rename a session and break every peer's addressing. pi
exposes no title source, so there a session name is adopted only when it already looks like an
address: one token, no whitespace, within the length cap. A `/rename` is picked up within 5 s.

Name collisions deconflict by start time: the older session keeps the bare name, the younger gets a
`-<pid>` suffix.

## How it works

- Each process writes `~/.agent-collective/<profile>/<pid>.json` (0600) and listens on `<pid>.sock`
  beside it. The record is written at start, on rename, and when a turn starts or ends — there is
  no heartbeat loop, and no process reads anyone else's record until a tool asks.
- A record is removed only when its process is gone (`kill(pid, 0)`). A live process's files are
  never touched by anyone else, however old its record: a laptop sleep or a stalled event loop is
  not death.
- Every 5 s each process `stat`s its own socket. If the file is missing or is not the one it bound,
  it binds a fresh temporary path and renames it into place. A sender that hits a missing or
  refusing socket on a live peer waits up to 7 s for it to re-appear and retries once.
- Contacts live in `~/.agent-collective/<profile>/contacts/<session-id>.json`.

## Limits

- **Same machine only.** Unix sockets, one directory per profile. For remote pairing use omp's
  `/collab`.
- **0.3.x and 0.4 sessions cannot see each other.** 0.4 moved records into per-profile directories;
  restart every session after upgrading.
- **A suspended peer cannot answer.** Sends to a `SIGSTOP`ped or sleeping process fail after the
  7 s wait; `peers` marks a record not updated for 5+ minutes as possibly suspended.
- **Chains stop at 4 hops.** Every message carries its distance from the human prompt that started
  the chain; past the limit, delivery is refused with an explicit error telling the sender the chain
  ends there, and a local warning is shown. A message that wakes an idle agent sets the hop for
  everything that turn sends; one that steers into a running turn only affects replies to its
  sender. A human prompt or the end of the turn resets the count. This exists because mutual wake
  is a *behavioural* loop — A wakes B, B's turn wakes A — where each delivery is a legitimate
  single hop, so no transport-level guard trips. Raise or lower `MAX_HOPS` in `index.ts` if 4 is
  wrong for you.
- **Bursts become one wake.** Messages from one peer arriving within 400 ms are delivered as a single
  numbered batch, so N messages cost one turn rather than N.

## Development

```sh
npm test   # spawns real processes on real sockets under a temp HOME (~30 s)
```

## License

MIT
