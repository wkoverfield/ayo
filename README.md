<div align="center">

<img src="docs/hero.png" alt="Ayo: keep communicating and keep coding. Terminal-native pings for small teams, git context attached." width="840">

[![CI](https://github.com/wkoverfield/ayo/actions/workflows/ci.yml/badge.svg)](https://github.com/wkoverfield/ayo/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@ayo-dev/cli)](https://www.npmjs.com/package/@ayo-dev/cli)
[![downloads](https://img.shields.io/npm/dm/@ayo-dev/cli)](https://www.npmjs.com/package/@ayo-dev/cli)
[![license](https://img.shields.io/npm/l/@ayo-dev/cli)](LICENSE)

</div>

Ayo keeps a small team in sync without anyone leaving their terminal or their
coding agent. You ping a teammate, it lands where they already are (a native
notification, their inbox, or dropped into their agent's next turn), and their
reply lands back in yours. Nobody alt-tabs, nobody loses their place.

Every ping carries your git context automatically (repo, branch, changed
files), so "the auth endpoint is live" arrives with the what. Git and your
existing tools stay the source of truth. Ayo never calls an LLM, and it forgets
your 1:1 pings on purpose. It is a sidechannel, not a second inbox to keep up
with. Built for teams of about five or fewer who live in their terminals.

```bash
npm install -g @ayo-dev/cli

ayo init      # login, pick a sound, wire your agents, then ping yourself to prove it works
```

`ayo init` ends by pinging you, so you see the toast and hear your sound in under
a minute, no teammate required. Then `ayo team create` prints a join code, and
the rest is `ayo <name> "..."`.

## The problem

You are deep in the backend, Maya is deep in the UI, and she has been blocked on
your auth endpoint for an hour. It just went live. Now you get to alt-tab to
Slack, find the channel, type the message, and lose your place. When she sees
it twenty minutes later, she alt-tabs out of her own flow to ask which branch.
Two people out of flow to move one sentence.

Your agent can write the endpoint. It cannot tell Maya she is unblocked. Only
you know that, the moment it becomes true. Ayo moves that moment from your flow
to hers, context attached, without either of you leaving the terminal:

```bash
ayo maya "auth endpoint is live, you're unblocked"   # lands as a toast + in her agent
ayo team "schema changed, pull before you build"     # tell everyone
ayo maya --urgent "prod deploy is red"               # break through heads-down
```

Or, from inside Codex or Claude Code, since you are probably already in there:

> _"Ayo Maya that the endpoint's live and include my current branch."_

## What it does

- **Ping with context.** A message carries your repo, branch, and changed files
  automatically, so "can you look?" arrives with the what.
- **Respect focus.** Heads-down holds non-urgent pings for the inbox; urgent
  breaks through. The board shows who is reachable before you ping.
- **Answer your own agents.** When your agent hits a fork it should not take
  alone (deploy to prod, pick an approach), it asks you and waits, instead of
  guessing and moving on.
- **Bring the outside in.** Point CI, cron, a script, or GitHub at a webhook and
  the events that need you show up in your terminal instead of an email you will
  not read.
- **See the board.** One pane: who is online, who is heads-down, which handoffs
  are still open.
- **Hand off when you need to.** `ayo handoff` sends your branch, changed files,
  and blocker, plus a link that even someone not on Ayo yet can open and reply
  from.
- **Agent-native.** An MCP server lets your agent ping, hand off, read your
  inbox, and ask on your behalf.

## Handing off

When you do need to put your work in someone else's hands, `ayo handoff maya
"the deploy is yours"` sends your branch, changed files, and diff stat, and
mints a shareable page that renders all of it. That page is for the teammate
who hasn't installed Ayo yet: they can read the context and reply right from
it, no account needed. Their answer lands in your terminal.

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
  connection per team you're on and pops a native notification the instant an
  Ayo arrives, whichever team it came from. No `watch` pane to babysit.
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

## Contributing

Contributions are welcome: a bug report, a fix, a notification path on a
platform I got wrong, or a new agent host for the MCP server. Ayo is opinionated
and has a few load-bearing properties (truthful output, the relay as the only
identity boundary, no LLM calls, a sidechannel not a second inbox); see
[CONTRIBUTING.md](CONTRIBUTING.md) for how to run it locally and what fits. Open
an issue first for anything touching the relay or the wire protocol.

Found a security issue? Please report it privately, via [SECURITY.md](SECURITY.md).

## License

MIT
