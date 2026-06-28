# Auth setup — GitHub device flow

Ayo authenticates with the **GitHub OAuth device flow**: `ayo login` prints a
code, you enter it at github.com/login/device, and the relay exchanges it for an
Ayo session token. The device flow needs only a **client ID** (no client secret),
which is why it's safe for a CLI.

## 1. Register a GitHub OAuth App

1. github.com → Settings → Developer settings → **OAuth Apps** → **New OAuth App**.
2. Fill in:
   - **Application name:** Ayo
   - **Homepage URL:** your relay URL (or the repo)
   - **Authorization callback URL:** anything (unused by device flow), e.g. the
     homepage URL.
3. Create it, then on the app page **check "Enable Device Flow"** and save. This
   is required — without it, GitHub returns `device_flow_disabled`.
4. Copy the **Client ID** (looks like `Iv1.xxxxxxxxxxxx`).

## 2. Configure the relay

The client ID is set as a Worker secret (never committed):

```bash
cd packages/relay
wrangler secret put GITHUB_CLIENT_ID     # paste the Client ID
wrangler secret put INTERNAL_SECRET      # any long random string
```

`INTERNAL_SECRET` authenticates Worker→Durable-Object sub-requests; generate one
with e.g. `openssl rand -hex 32`.

**Do not set `AYO_DEV_AUTH` in production.** It enables the no-GitHub dev stub.
If it's unset and `GITHUB_CLIENT_ID` is also unset, the relay fails closed
(`Auth is not configured`) rather than allowing anonymous logins.

## 3. Local development

Local dev uses `.dev.vars` (gitignored) instead of real GitHub. Copy the example:

```bash
cd packages/relay
cp .dev.vars.example .dev.vars     # AYO_DEV_AUTH=1 enables the stub
```

With the stub on, `ayo login --handle <name>` mints a local user instantly — no
browser, no GitHub. This is what the end-to-end tests use.

## How it maps to Ayo users

On successful GitHub login the relay reads `GET /user` and maps the GitHub
**numeric id** to a stable Ayo user (`ghuser:<id>` → userId). The Ayo handle
defaults to the GitHub login, so a future GitHub username change won't orphan the
account. See [ADR 0002](adr/0002-relay-contract-and-message-schema.md).
