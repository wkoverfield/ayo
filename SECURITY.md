# Security Policy

Ayo authenticates you with GitHub, holds a session token on your machine, and
routes messages and work context between teammates through a relay. Anything
that could leak a token, let someone send or read as another person, or expose
one team's traffic to another, I take seriously.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Instead, either:

- Use GitHub's private [Report a vulnerability](https://github.com/wkoverfield/ayo/security/advisories/new)
  form, or
- Email wkoverfield@gmail.com with `ayo security` in the subject.

Include the smallest repro you can, the version (`ayo --version`), and what you
expected versus what happened. I aim to acknowledge within a few days.

## What counts

The relay is the only place identity is verified, and the Durable Object never
trusts a client-supplied identity (see [ADR 0002](docs/adr/0002-relay-contract-and-message-schema.md)).
Reports that especially matter:

- **Identity / authorization:** sending or reading as someone you aren't,
  injecting or forging the trusted `x-ayo-*` identity into the DO, joining or
  reading a team you're not a member of, or a webhook/handoff path that
  re-rosters or impersonates a member.
- **Token exposure:** a session or webhook token that leaks into a log, an error
  message, a rendered page, or another user's response.
- **The public surfaces:** injection or XSS on the handoff share page, or abuse
  of the anonymous reply / inbound webhook / GitHub webhook endpoints (rate-limit
  bypass, forged signatures, amplification).
- **Path traversal or injection** through handles, tokens, team/handoff ids, or
  webhook and handoff-page content.

Sessions expire 90 days after their last use (rolling), and `ayo logout`
revokes this machine's token immediately. Listing/revoking OTHER machines'
sessions isn't built yet — flagged in docs/FOLLOWUPS.md.

## Supported versions

Ayo is pre-1.0 and moves fast. Fixes land on the latest published
`@ayo-dev/cli` release and a redeploy of the relay; please reproduce against the
current version before reporting.
