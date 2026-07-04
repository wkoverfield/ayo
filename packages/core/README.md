# @ayo-dev/core

Shared message schema, wire protocol, and TypeScript types for
[Ayo](https://github.com/wkoverfield/ayo) — used by the CLI, the MCP server, and
the relay.

This is an internal building block; you probably want
[`@ayo-dev/cli`](https://www.npmjs.com/package/@ayo-dev/cli) instead.

The root export is platform-neutral (no Node builtins) and safe anywhere,
including Cloudflare Workers. `@ayo-dev/core/node` is Node-only client runtime
(~/.ayo config/session IO, the relay HTTP transport, git context capture) shared
by the CLI and the MCP server — never import it from a Workers environment.

MIT © Wilson Overfield
