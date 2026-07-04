<div align="center">

<img src="docs/hero.png" alt="Ayo: reach a teammate without leaving your terminal or your agent. Ping them, or hand off your work with its git context." width="840">

[![CI](https://github.com/wkoverfield/ayo/actions/workflows/ci.yml/badge.svg)](https://github.com/wkoverfield/ayo/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@ayo-dev/cli)](https://www.npmjs.com/package/@ayo-dev/cli)
[![downloads](https://img.shields.io/npm/dm/@ayo-dev/cli)](https://www.npmjs.com/package/@ayo-dev/cli)
[![license](https://img.shields.io/npm/l/@ayo-dev/cli)](LICENSE)

</div>

Ayo is a command-line tool for reaching a teammate without leaving your terminal
or your coding agent. You ping someone, or hand off your work with its git
context, and it lands where they are already working: a native notification,
their inbox, or dropped into their agent's next turn.

It captures the context for you (repo, branch, changed files, diff stat, the
blocker), so a handoff carries what you were doing and not just "hey, look at
this." Git and your existing tools stay the source of truth. Ayo never calls an
LLM, and it forgets your 1:1 pings on purpose. It is a sidechannel, not a second
inbox to keep up with.

<!-- Demo GIF: `vhs scripts/demo.tape` writes docs/demo.gif, then uncomment:
<p align="center"><img src="docs/demo.gif" alt="wilson runs 'ayo handoff maya' in one pane; the link prints, maya's pane shows a native toast and 'ayo inbox' rendering the branch, files, and blocker; maya replies and it lands back in wilson's terminal." width="720"></p>
-->

```bash
npm install -g @ayo-dev/cli

ayo init      # login, pick a sound, wire your agents, then ping yourself to prove it works
```

`ayo init` ends by pinging you, so you see the toast and hear your sound in under
a minute, no teammate required. Then `ayo team create` prints a join code, and
the rest is `ayo <name> "..."`.

## The problem

It is 2am and the demo is on fire. You want to pull in a teammate, so you
alt-tab to Slack, screenshot your terminal, paste the branch name, explain which
service, and by the time they answer you have lost your place in the thing that
was actually broken.

The message was never the hard part. The context was. Ayo sends the context with
the message and keeps you in the terminal where the fire is:

```bash
ayo maya "demo deploy is cooked, can you tap in?"    # ping one person
ayo team "standup in 5"                              # tell everyone
ayo handoff maya "stuck on the oauth callback"       # hand off with context + a link
```

Or, from inside Codex or Claude Code, since you are probably already in there:

> _"Ayo Maya with my current branch, changed files, and the blocker."_

## What it does

- **Ping with context.** A message carries your repo, branch, and changed files
  automatically, so "can you look?" arrives with the what.
- **Hand off with a link.** Every handoff becomes a page anyone can open, even
  without Ayo, and reply from. A Loom-style link for a blocker.
- **Answer your own agents.** When your agent hits a fork it should not take
  alone (deploy to prod, pick an approach), it asks you and waits, instead of
  guessing and moving on.
- **Bring the outside in.** Point CI, cron, a script, or GitHub at a webhook and
  the events that need you show up in your terminal instead of an email you will
  not read.
- **See the board.** One pane: who is online, who is heads-down, which handoffs
  are still open.
- **Agent-native.** An MCP server lets your agent ping, hand off, read your
  inbox, and ask on your behalf.

## Hand off with a link

Every `ayo handoff` mints a shareable link, a page that renders your branch,
changed files, diff stat, and the blocker for anyone, even before they are on
Ayo:

```bash
ayo handoff maya "stuck on the oauth callback"
  ✓ handoff sent
  ✓ share link  https://…/h/AbCd…      # works for anyone, expires on its own
```

Drop it in a text, a PR comment, wherever. Whoever opens it gets your full
context and can reply right from the page, no account and no install. Their
answer lands in your terminal, threaded to the handoff. The install nudge comes
after they reply, and the embedded join code names you as the inviter, so
whoever picks it up starts on your team instead of in an empty room.

Handoffs only attach the full diff when you pass `--with-diff`, since a diff can
carry uncommitted secrets. `--no-code` shares context without granting join
access, and `--no-link` skips the link.

## When your agent needs a decision

An agent should not deploy to prod, spend money, or pick between two approaches
on its own. With the MCP server installed, it can ask you and wait:

```bash
# your agent, mid-task, calls request_approval and blocks on:
#   "Retry queue: exponential backoff or fixed interval?"

ayo agents                 # the questions waiting on you, oldest first
ayo answer 1 backoff       # it unblocks and keeps going
```

The ask reaches you wherever you are (it pierces your own heads-down, because a
blocked agent is your work), and your answer routes back as the tool's result.
If you never answer, the agent gets a clean timeout and proceeds on its stated
default, so nothing hangs forever.

## Bring the outside in

Attention should not only come from people. `ayo webhook create` mints a
revocable webhook URL so any system can turn an event into an Ayo:

```bash
ayo webhook create --label ci --to wilson  # one curl becomes an Ayo
  curl -X POST https://…/v1/hooks/<token> -d '{"text":"build failed on main"}'

ayo webhook create --github                 # HMAC-verified GitHub webhook
```

The `--github` webhook maps the moments that actually need you (a review requested,
an @mention in a PR thread, a review submitted on your PR) to an Ayo for the
matching handle, where your Ayo handle is your GitHub login. Inbound automation
always respects focus and never breaks through heads-down.

## The live team board

`ayo board` is a glanceable HUD you leave up in a pane: who is online, who is
heads-down, which handoffs are open, and recent team activity, updating live.

```
  ⚡ Hack Midwest        3/4 online        ● live
  ──────────────────────────────────────────────────────
  ● wilson      2m   ayo@feat/auth      "wiring oauth"
  ● maya       now   web@main           "deploy is dead"
  ○ kenny      18m   —                  offline
  ──────────────────────────────────────────────────────
  ⤷ open handoffs
    maya → team   deploy broken, need eyes   unclaimed 6m
  ──────────────────────────────────────────────────────
  recent
    now  maya   ▸ we're cooked, all hands
    2m   wilson ⤷ shipped auth
```

It shows team activity only, broadcasts and handoffs. Your 1:1 pings and replies
stay private in `ayo inbox`.

## Use it from inside the agent

`ayo mcp install` registers Ayo's tools with Codex, Claude Code, and Cursor, so
your agent can ping, hand off, read, and ask for you: `send_ayo`, `read_inbox`,
`share_context`, `create_handoff`, `request_approval`, `team_status`,
`set_status`, `resolve_ayo`. Just ask:

> _"Ayo Kenny that the deploy's cooked and include my current branch."_
> _"Hand this off to Maya with a summary of where I'm stuck."_
> _"Check my Ayo inbox and summarize anything urgent."_

It shares your CLI identity, so you log in once.

## How it works

Ayo is not another chat app. It is local infra, so your machine receives Ayos no
matter where you are: Codex, Claude Code, the terminal, the browser, whatever.

```
Relay ─▶ local Ayo daemon (ayod) ─▶ OS notification + local inbox   ← always on, real-time
                               ─▶ agent hooks surface unread at turn/session boundaries
                               ─▶ MCP / CLI read & reply on demand
```

- **The daemon receives.** A tiny background service holds one realtime
  connection to the relay and pops a native notification the instant an Ayo
  arrives. No `watch` pane to babysit.
- **The agents surface it.** `ayo hooks install` makes Claude Code
  (`SessionStart` + `UserPromptSubmit`) quietly drop your unread Ayos into the
  model at natural breakpoints, so the ping feels native when your agent picks
  back up. Codex's `notify` gets a toast fallback.
- **You reply on demand.** _"check my Ayos"_ inside the agent, or `ayo inbox`.

It is honest about what it knows: `sent` is not `delivered` is not `notified` is
not `read`. A toast firing tells the sender your machine buzzed, not that you
looked.

<details><summary>Set it up step by step instead of <code>ayo init</code></summary>

```bash
ayo login                       # GitHub device flow
ayo daemon install              # install ayod (your receiver) as a login service
ayo mcp install                 # use Ayo from inside Codex & Claude
ayo hooks install               # surface unread Ayos in-agent
```

`ayo daemon install` registers `ayod` as a **launchd** (macOS) or **systemd
--user** (Linux) service that starts on login and survives reboots. When
something looks off, `ayo doctor` checks the relay, the daemon, your agent
wiring, and fires a test toast.

</details>

<details><summary>Try it solo on one machine (no teammate)</summary>

The local relay has a dev stub that lets you be two people with no second laptop
and no GitHub account. `AYO_DIR` keeps each persona's files separate.

```bash
# Terminal 1: local relay (dev stub on)
cd packages/relay && npx wrangler dev --local --port 8787

# Terminals 2 & 3: run in each first:
export AYO_RELAY_URL=http://127.0.0.1:8787
alias ayo="node $(git rev-parse --show-toplevel)/packages/cli/dist/ayo.js"

# Terminal 2: you
export AYO_DIR=/tmp/ayo-you
ayo login --handle you && ayo team create "Self Test"   # copy the join code
ayo daemon start                                        # your receiver

# Terminal 3: your alter ego
export AYO_DIR=/tmp/ayo-pal
ayo login --handle pal && ayo join <CODE>
ayo you "does this actually work?"     # Terminal 2 gets a native toast
```

Or run [`scripts/demo.sh`](scripts/demo.sh) for a scripted walkthrough.

</details>

## What Ayo is not

- **Not a chat app.** No threads, no reactions, no history to scroll. Handoffs
  show on the board and pings live in your inbox until you read them. If you want
  a conversation, you already have one open somewhere.
- **Not a feed.** It is a sidechannel for the moment something needs a human, not
  a stream you have to stay on top of. Quiet is the default.
- **Not zero-infra.** It needs the hosted relay (or your own, it is a Cloudflare
  Worker you can self-host) and a background daemon on macOS or Linux.
- **Not fully branded on macOS yet.** The clickable, logo'd notification needs a
  signed and notarized helper (in progress). Until then macOS shows a standard
  toast. Windows and Linux already carry the Ayo icon.

## Packages

| Package | What it is |
|---|---|
| [`@ayo-dev/cli`](packages/cli) | The `ayo` command plus the `ayod` background daemon |
| [`@ayo-dev/mcp`](packages/mcp) | MCP server exposing the Ayo tools to Codex/Claude |
| [`@ayo-dev/core`](packages/core) | Shared message schema, wire protocol, and types |
| [`relay`](packages/relay) | Cloudflare Worker + Durable Object: realtime fanout, one DO per team |

## Design notes

- [ADR 0001: Receive path is daemon-first, not MCP-first](docs/adr/0001-receive-path-daemon-first.md)
- [ADR 0002: Relay contract, message schema, and wire protocol](docs/adr/0002-relay-contract-and-message-schema.md)
- [Auth setup](docs/auth-setup.md) · [MCP setup](docs/mcp-setup.md) · [Follow-ups](docs/FOLLOWUPS.md)

## Development

```bash
pnpm install
pnpm -r build
pnpm dev:relay      # local Worker + Durable Object via wrangler
```

## License

MIT
