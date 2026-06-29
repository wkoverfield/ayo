# @ayo-dev/mcp

**The [MCP](https://modelcontextprotocol.io) server for [Ayo](https://github.com/woverfield/ayo)** — lets
Codex and Claude Code ping your teammates with work context, read their inbox,
and hand off work, without you leaving the agent.

## Install

The easiest path is through the CLI, which registers this server with both
Claude Code and Codex for you:

```bash
npm install -g @ayo-dev/cli
ayo login
ayo mcp install
```

Or wire it up manually:

```bash
# Claude Code (user scope, so it follows you across repos)
claude mcp add -s user ayo -- npx -y @ayo-dev/mcp

# Codex (~/.codex/config.toml)
[mcp_servers.ayo]
command = "npx"
args = ["-y", "@ayo-dev/mcp"]
```

The server reads your Ayo session from `~/.ayo` (created by `ayo login`).

## Tools

| Tool | What it does |
| --- | --- |
| `send_ayo` | Ping a teammate or broadcast to the team |
| `read_inbox` | Read your Ayos (optionally unread-only) |
| `create_handoff` | Hand off work with branch + diff context |
| `share_context` | Push your current repo/branch/blocker to the team |
| `resolve_ayo` | Mark an Ayo resolved |
| `set_status` | Set your presence/status |
| `team_status` | See who's online and what they're on |

## Full docs

See the [main repository](https://github.com/woverfield/ayo).

MIT © Wilson Overfield
