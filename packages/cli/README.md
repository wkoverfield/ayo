<div align="center">
<img src="https://raw.githubusercontent.com/wkoverfield/ayo/main/docs/ayo-logo.png" alt="Ayo" width="120">
</div>

# @ayo-dev/cli

**Ping your teammates from inside Codex and Claude, without leaving your terminal.**

Ayo is a tiny CLI + background daemon that lets coding agents (and you) send
work-context pings to your team. Your agent finishes a handoff, hits a blocker,
or ships a branch, and your teammate gets a native desktop notification with the
repo, branch, and a one-line "why," straight from the tool they're already in.

```bash
npm install -g @ayo-dev/cli
ayo login                       # GitHub device flow
ayo team create "Hack Midwest"  # share the join code
ayo daemon install              # receiver as a login service → survives reboots
```

## What you get

```bash
ayo team "we're cooked, prod is down"     # broadcast to the whole team
ayo maya "can you take the auth flow?"    # direct ping a teammate (ayo all "..." broadcasts)
ayo handoff maya "merged #42, you're up"  # hand off work with branch context
ayo board                                 # live team dashboard (who's online, recent activity)
ayo hackathon start "Hack Midwest" --ends 18h   # shared deadline + ⏰ milestone nudges
ayo hackathon export > story.md           # the event as a markdown timeline
```

The `ayod` daemon holds one WebSocket to the relay and fires a native
notification the moment a ping lands — so you actually *see* it, even when the
agent that received it has moved on.

## Agent-native

Ayo registers as an [MCP](https://modelcontextprotocol.io) server, so your agent
can send pings itself:

```bash
ayo mcp install        # registers with Claude Code + Codex
```

Tools: `send_ayo`, `read_inbox`, `create_handoff`, `share_context`,
`resolve_ayo`, `set_status`, `team_status`.

## Full docs

See the [main repository](https://github.com/wkoverfield/ayo) for the architecture,
self-hosting the relay, and the demo.

MIT © Wilson Overfield
