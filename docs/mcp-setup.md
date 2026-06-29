# MCP setup — use Ayo from inside Codex & Claude

The Ayo MCP server exposes Ayo as tools your agent can call:
`send_ayo`, `read_inbox`, `share_context`, `create_handoff`, `team_status`,
`set_status`, `resolve_ayo`. It shares your CLI identity (reads `~/.ayo`), so log
in once with `ayo login` and the tools act as you.

## One command

```bash
ayo mcp install          # registers with both Codex and Claude Code
ayo mcp status           # show where it's registered
ayo mcp uninstall        # remove it
```

Use `--claude` or `--codex` to target just one. **Restart your agent** afterward
so it picks up the new server.

What it does:
- **Claude Code** — runs `claude mcp add -s user ayo -- …` (user scope).
- **Codex** — adds a `[mcp_servers.ayo]` table to `~/.codex/config.toml`
  (idempotent, preserves your other config).

## Manual setup

If you'd rather wire it yourself:

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.ayo]
command = "node"
args = ["/absolute/path/to/ayo/packages/mcp/dist/index.js"]
```

**Claude Code:**

```bash
claude mcp add -s user ayo -- node /absolute/path/to/ayo/packages/mcp/dist/index.js
```

(Once `@ayo-dev/mcp` is published, the command becomes `npx -y @ayo-dev/mcp` and
`ayo mcp install` uses that automatically.)

> In dev, the absolute path to `packages/mcp/dist/index.js` is baked into your
> agent config at install time. If you **move the repo** or wipe
> `packages/mcp/dist`, re-run `ayo mcp install` (and rebuild) so the path is
> current — otherwise the agent will try to launch a server that no longer exists.

## Using it

In Codex or Claude Code, just ask:

> _"Ayo Kenny that the deploy is cooked and include my current branch."_
> _"Check my Ayo inbox and summarize anything urgent."_
> _"Hand this off to Maya with a summary of where I'm stuck."_

Privacy note: `create_handoff` and `share_context` only include the full git diff
when you explicitly ask (`withDiff`), since a diff can contain uncommitted
secrets. By default they send branch + changed-file names + diff stat only.
