---
tags: runbook, polaris-id, auth, production
confirm: true
---
# Polaris ID Console Group Required

Owner only. Agents never deploy or use `--remote` (AGENTS.md).

Use to turn on `OIDC_CONSOLE_GROUP_REQUIRED` (default `"false"`). Afterwards, console routes (org routes, members and invitations, audit, metrics, scan administration) answer `403 CONSOLE_ACCESS_REQUIRED` to a Polaris ID session without the console group or the platform admin role, and the Admin menu item is hidden. Platform admins need no other group. API keys keep working. Email-link sessions in the console grace window are not affected and end with the grace.

## Prerequisites

- Polaris ID admin access and a finished Set up.
- The console group name used by `OIDC_ADMIN_GROUP` (`wallet_org_admins`, display name `wallet-org-admins`, or `passbook_console` after [[Polaris ID Group Rename]]).

## 1. Set up and drain

Settings, Polaris ID, Set up creates the console group and allows it on the client ([[Polaris Binding Turn On]]). Then add everyone who uses an org console to it, including every current org member, by inviting or granting through PassBook; wait until the card shows no members owed.

## 2. Switch it on

When the card reads ready, an agent PR sets `OIDC_CONSOLE_GROUP_REQUIRED` to `"true"` in `wrangler.jsonc`; merge it and CI deploys.

Sessions made before the change lack the role until the next sign-in: members sign out and in.

## Verify

Settings, Polaris ID shows the group names and whether the requirement is on. A Polaris ID user outside the group gets `403 CONSOLE_ACCESS_REQUIRED` on a console route.

## Undo

Set the var back to `"false"` and deploy.
