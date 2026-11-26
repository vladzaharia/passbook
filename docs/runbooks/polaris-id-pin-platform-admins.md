---
tags: runbook, polaris-id, auth, production
confirm: true
---
# Polaris ID Pin Platform Admins

Owner only. Agents never deploy or use `--remote` (AGENTS.md).

Use to restrict platform admin to named people. `OIDC_PLATFORM_ADMIN_SUBJECTS` (default empty) is a comma list of Polaris ID subject ids (the `sub` claim). While it is not empty, platform admin needs the admin group and a listed subject; a group member who is not listed signs in without admin. Empty keeps group-only behaviour.

## Prerequisites

- Polaris ID admin access, to read each person's subject id.

## 1. Add the subject before the person joins the group

Add each subject id to `OIDC_PLATFORM_ADMIN_SUBJECTS` in `wrangler.jsonc`, commit, then [[Deploy]]. Add the person to the admin group only after this deploy.

## 2. End old sessions

Existing sessions keep their roles until they end. Revoke platform admin sessions, or have admins sign in again.

## Verify

Settings, Polaris ID shows the group lists and how many subjects are pinned (a count only, never the ids).
