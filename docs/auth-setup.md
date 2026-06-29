# Auth setup — GitHub device flow

Ayo authenticates with the **GitHub device flow**: `ayo login` prints a code, you
enter it at github.com/login/device, and the relay exchanges it for an Ayo
session token. The device flow needs only a **client ID** (no client secret, no
private key) — which is why it's safe for a CLI.

This works with either a **GitHub App** (GitHub's recommended path; what Ayo uses)
or a classic **OAuth App**. The relay code is identical for both.

## 1. Register a GitHub App

github.com → Settings → **Developer settings** → **GitHub Apps** → **New GitHub App**.

Most fields are left blank. What matters:

| Field | Value |
|---|---|
| **GitHub App name** | e.g. `Ayo CLI` — globally unique across GitHub; its slug must not collide with an existing user/org (e.g. `ayo-dev` is taken). |
| **Homepage URL** | your repo, e.g. `https://github.com/wkoverfield/ayo` |
| **Callback URL** | leave blank — device flow never redirects |
| **Expire user authorization tokens** | uncheck — Ayo uses the GitHub token once (to read your identity) then issues its own session token |
| **Request user authorization (OAuth) during installation** | leave unchecked |
| ✅ **Enable Device Flow** | **check this** — without it, login fails with `device_flow_disabled` |
| **Webhook → Active** | **uncheck** — otherwise GitHub requires a Webhook URL |
| **Permissions** (all) | leave at **No access** — reading your own identity via `GET /user` needs none |
| **Where can this be installed** | **Any account** so teammates can log in too (or "Only on this account" for solo use) |

Create the app, then copy its **Client ID** (looks like `Iv23li…`).

> OAuth App alternative: Developer settings → **OAuth Apps** → New OAuth App.
> Simpler form (no webhook/permissions), but GitHub funnels you to GitHub Apps.

## 2. Configure the relay

The client ID is set as a Worker secret (it isn't actually secret for the device
flow, but `wrangler secret` keeps it out of the committed config):

```bash
cd packages/relay
wrangler secret put GITHUB_CLIENT_ID     # paste the Client ID
wrangler secret put INTERNAL_SECRET      # any long random string: openssl rand -hex 32
```

`INTERNAL_SECRET` authenticates Worker→Durable-Object sub-requests.

**Do not set `AYO_DEV_AUTH` in production.** It enables the no-GitHub dev stub.
If it's unset and `GITHUB_CLIENT_ID` is also unset, the relay fails closed
(`Auth is not configured`) rather than allowing anonymous logins.

## 3. Local development

Local dev reads vars from `packages/relay/.dev.vars` (gitignored). Copy the
example:

```bash
cd packages/relay
cp .dev.vars.example .dev.vars
```

- With `AYO_DEV_AUTH=1`, `ayo login --handle <name>` mints a local user instantly
  — no browser, no GitHub. This is what the end-to-end tests use.
- To exercise the **real** GitHub flow locally, set `GITHUB_CLIENT_ID=<id>` and
  comment out `AYO_DEV_AUTH`; `ayo login` then does the real device flow against
  github.com (the local Worker makes the outbound calls). Verified working with
  the `Ayo CLI` GitHub App.

## How it maps to Ayo users

On successful login the relay reads `GET /user` and maps the GitHub **numeric id**
to a stable Ayo user (`ghuser:<id>` → userId). The Ayo handle defaults to the
GitHub login, so a future GitHub username change won't orphan the account. See
[ADR 0002](adr/0002-relay-contract-and-message-schema.md).
