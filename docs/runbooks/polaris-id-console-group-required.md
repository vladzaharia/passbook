---
tags: runbook, polaris-id, auth, production
confirm: true
---
# Polaris ID Console Group Required

Owner only. Agents never deploy or use `--remote` (AGENTS.md).

Use to turn on `OIDC_CONSOLE_GROUP_REQUIRED` (default `"false"`). Afterwards, console routes (org routes, members and invitations, audit, metrics, scan administration) answer `403 CONSOLE_ACCESS_REQUIRED` to a Polaris ID session without the console group or the platform admin role, and the Admin menu item is hidden. Platform admins need no other group. API keys keep working. Email-link sessions in the console grace window are not affected and end with the grace.

## Prerequisites

- Polaris ID admin access.
- The console group name used by `OIDC_ADMIN_GROUP` (`wallet_org_admins`, display name `wallet-org-admins`, or `passbook_console` after [[Polaris ID Group Rename]]).

## 1. Create the group and add everyone

In Polaris ID create the console group and add everyone who uses an org console, including every current org member.

## 2. Allow it on the client

Add the group to the PassBook client's allowed groups in Polaris ID.

## 3. Switch it on

Set `OIDC_CONSOLE_GROUP_REQUIRED` to `"true"` in `wrangler.jsonc`, commit, then [[Deploy]].

Sessions made before the change lack the role until the next sign-in: members sign out and in.

## Verify

Settings, Polaris ID shows the group names and whether the requirement is on. A Polaris ID user outside the group gets `403 CONSOLE_ACCESS_REQUIRED` on a console route.

## Undo

Set the var back to `"false"` and deploy.
