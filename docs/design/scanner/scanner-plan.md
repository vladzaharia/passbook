# Scanner implementation plan

How to build PassBook's scanner. Written for engineers who have only this file and the docs it links. 2026-11-04.

> **Revision 2026-11-04** (the owner's three changes):
> - **Two new streams.** **DS** (display: the model, schema, renderer, presets, defaults, role filter, history and the
>   server display) and **TD** (the template designer: the Scanning, NFC and new **Scan screen** sections, so no other
>   stream touches designer files). AD's designer tasks moved to TD.
> - **Screens and buddy rebuilt for B strengthened** (UI.2-UI.6, BU.1, BU.3), with the visual direction isolated in
>   those two streams (§3 rule). CC's machine gains the card layer; `NEXT_SCAN_AFTER_VERDICT` is 350.
> - **Ownership fixed** so no two streams share a file (§3); new frozen contracts C15-C19 (§4.1).
> - **Migrations:** `0014` gains `scan_events.note` and the `scans_pass_ok` index; new
>   `0018_templates_build_key.sql` (PT.7) for display-only versions. No ledger or visit tables: history is computed.
> - **Milestones:** M1 ships the default and blueprint displays, the renderer and the B result card; M2 the Scan screen
>   editor and display-only versions; M3 the real-pass preview. New e2e specs `16-scan-display` and
>   `16-scan-designer`; the definition of done adds the fit test, display safety and the direction-isolation check.
> - **Review fixes** (DM R15-R19, §1.5 last rows): the per-screen fit budget with a render-time cut; a literal band
>   title (widened to the holder's name by the owner answers below); wider secret rules; `ScanOutcome.template` for
>   mode mismatches; the store card as a balance card (now the **Balance card**); e2e
>   template fixtures; bundle markers that survive minification.
> - **Head shake** (owner, later the same day: "The 'Voided'/'Invalid' etc should have the buddy shaking his head"):
>   every red refusal plays one `shake` beat and slate ends in a `sorry` pose (BM §6.3-6.4, M12-M13); `peek`, `tear`,
>   `sign` and `empty` are retired. New task **BU.5**; BU.1 no longer exports `TEAR`; BF gains the refused strip, stills
>   and video.
> - **Owner answers** (`scanner-owner-answers.md`): the band title takes literal text plus the holder's name only, up to
>   2 lines for 1 more unit (§4.2 display rules, DS.1, TD.3); **PT.3 Blueprints** ships the **Balance card** and a new
>   **Stamp card**, and the e2e coffee and prepaid fixtures use them (DS.2, IN.1, §9); BU.3 gains the `coins` beat; no
>   memo column (§7); "starter" is **Blueprint** in strings and new code names; the earliest cut is T0 + 350
>   in BM too (§1.5).

**Base.** Branch `next/integration` (HEAD `237b4ce`, n6 and n7 already merged). Every path is relative to the repo
root. The design docs live in `docs/design/scanner/` (copied there by task P0.7). Every later reference to a doc in
this plan means that copy.

**Sources, and which one wins.**

| Short | File | Wins on |
| --- | --- | --- |
| **SA** | `scanner-architecture.md` | principals, rights, data, API, reasons, timings, security |
| **SD** | `scanner-design.md` | everything a person sees: layout, copy, components, admin pages |
| **DM** | `docs/design/scanner/display-model.md` | the result content: `scan.display`, its schema, limits and codes, the renderer, presets, bindings, history, the editor (§10) |
| **BF** | `docs/design/scanner/b-final.md` and `sheets/` | the result screens' geometry, z-order, type steps, tokens and motion (B strengthened) |
| **BM** | `buddy-motion.md` | beat choreography, poses, props, sound notes, buddy tests |
| **AC** | `arch-client.md` | the client reducer tables (§3), decoder constants (§2.3), wedge (§2.4), file tree (§8), tests (§10) |
| UD, UK, UA | `ux-door.md`, `ux-desk.md`, `ux-admin.md` | only the detail SD doesn't restate (keypad behaviour, empty states, toasts) |
| PM | `platform-map.md` | facts about today's code |
| R | `research/scanning/report.md` | background; its critic block overrides its body |
| ME, UC, UP | `docs/design/{motion-and-expression,ui-consistency,ux-principles}.md` | platform design rules |

SA beats SD on data and behaviour. SD beats SA on what people see. DM and BF are detail references under SA and SD:
DM for result content, BF for result visuals. **This plan beats both on file ownership, order,
numbering and the corrections in §1.5.** `AGENTS.md` and `docs/engineering-standards.md` beat everything on
conventions.

---

## 0. Working rules

- **Branches.** Each stream works on `next/n8-<stream>` (for example `next/n8-sv`) in its own worktree. P0 branches
  from `next/integration`. The other streams branch from `next/integration` once P0 has merged.
- **Ownership.** Edit only your stream's paths (§3). If you need a change outside them, ask the stream that owns the
  file, or list it in your report. A contract change goes through the P0 lead (§4.1).
- **Tests first.** For every task, write the tests listed under "Tests first", watch them fail, then build.
- **Each task ends green.** Run `npm run check` before every merge request. It runs gen, biome (warnings fail),
  log codes, file sizes (300 soft, 330 hard), SQL owner, knip, typecheck, every test project, the build and both
  bundle budgets.
- **Platform rules** (`AGENTS.md`):
  - layering: routes, then service, then repo;
  - SQL only in `repo*.ts`;
  - `AppError` codes;
  - inject `ctx.clock` and `ctx.ids`;
  - zod for every input;
  - no silent `catch`;
  - a mutation and its audit row go in one `db.batch` with `auditStmt`;
  - `classifyD1Error`;
  - named exports and kebab-case file names;
  - web code uses the kit (`kit-lint.test.ts`).
- **Never log, audit or put in a URL:** a scan code, a barcode, a token (`wls_…`), a pairing code, a PIN, a search
  query, an email or a holder name. Log ids and error codes only.
- **Never deploy, never use `--remote`.** NFC stays off (`nfc.enabled = false`) in every environment.
- **Commits.** Small Conventional Commits with a one-line subject. Report every shared-file change.

---

## 1. Goal and scope

### 1.1 Goal

Ship a first-class scanner on one Worker:
- **`/scan`**: a staff web app on iPhone, iPad and desktop. It has door and desk postures, three ways in (camera,
  keyboard-wedge reader, manual lookup), green/amber/red/slate verdicts on the B-strengthened result card over a live
  camera, undo, counters and the buddy on the dock.
- **Admin Scanning**: scanners, events, staff and the scans log.
- **Scan actions in the template designer.**
- **A customizable result screen** per template (`scan.display`): the `ok` icon and title, meta line, chips, up to two
  information panels (membership, loyalty, balance, ticket, offer, access, details, note), from any pass data, with
  the verdict kept system-owned. Edited in the designer's **Scan screen** mode; a display-only save goes live on the
  next scan without a reissue.
- **NFC (Apple VAS)**: built end to end and switched off.

### 1.2 Now: this wave, in five milestones

| Milestone | Scope | Exit (demonstrated by e2e plus a device run) |
| --- | --- | --- |
| **M1 Door** | P0; migration `0014`; scanners, pairing, pair here, revoke, mode, sample pass; events (window, match, capacity); resolve; `check_in` with gates and the fast path; lookup by name, email and code; ledger and counts; scanner asset route; **the display**: model, validator, renderer, presets, defaults, role filter, history and the server display on every card and outcome; the `/scan` document: session, pairing, reducer with the card layer, wedge, manual entry, camera and zxing decoder, the B shell (capsule, tint and ring, dock), the result card and display painter, recent scans and undo of check-ins, v1 "Not confirmed" retries, sound, the buddy on the dock with poses and result beats; console tabs Scanners, Events (with the staff note) and Scans; blueprints switched to the scan code and shipped with displays | A phone paired from the console checks in a ticket from a template made with **Use blueprint** and shows its Ticket panel; a template with no display shows its Details default. Two doors can't admit the same ticket twice. A test pass is refused on a live scanner. `16-scan-door`, `16-scan-pair` and the M1 part of `16-scan-display` are green |
| **M2 Desk** | `add`, `take`, `set`, `use_up` through the `commit` hook; undo for every kind; staff with PINs, sign-in and Manager approval; template `scan` manifest, validator and designer **Scanning** section; desk panel, action area, keypad (dock tray on a phone), review, ready action and the promoted **Redeem reward**; display-only versions (`build_key`); the designer's **Scan screen** mode | A desk adds a stamp, redeems a reward and undoes it. A Manager PIN approves a `set`. An admin builds the VIP display in the designer, saves, and the next scan shows it with no pass version. `16-scan-desk`, `16-scan-designer` and `16-scan-display` are green |
| **M3 Door depth** | re-entry and check-out, bundle check-in, live event dashboard, summaries, milestones (`count`, `all_in`, `reward`), shift summary with the `count` scene, metrics and overview, `GET /api/v1/scans` feed and CSV, broadcast and pass-list scan targets, Sync log filter, terminals (till tokens), admin buddy moments, the designer's real-pass sample (`/api/v1/scan-display/preview`) | The dashboard updates every 5 s. Overview cards show scans. `16-scan-admin` is green |
| **M4 NFC (off)** | manifest `nfc`, `vas_keys`, five build gates, `nfc` injection, scoped reissue, serial rule, identity NFC card, reader keys made in the browser, Test a reader, designer **NFC** section, Settings switch, NFC runbook | Every gate is tested. The flag is off in every environment. A wedge read typed with `reader: 'nfc'` checks in as `method: 'nfc'` |
| **M5 Offline** | v2: roster, local decide, IndexedDB queue, batch sync, conflicts. v3: a `/scan` service worker for an offline cold start | An offline event scanner checks in from the roster. Its queue syncs, and conflicts show without interrupting the door |

**Release** needs M1 to M4. M5 follows and doesn't block it.

### 1.3 Later (not this wave)

- Door list on the device (AS §7.3).
- Outbound webhooks (a platform stream). The `scans:read` feed is the bridge until then.
- Server-side VAS decryption and a native `readVAS` shell. `nfc-bridge.ts` stays an interface.
- Org membership and tenant console access. SA §2.10 keeps the seam.
- The holder portal's **Last scan** line (`contracts/me.ts`; SD §11 "later slice"; this overrides SA §16.1 phase 3).
- Android and Google Smart Tap: out of scope.

### 1.4 NFC: what waits for Apple

Nothing in the build waits. The flag turns on only after all four of these:

1. Apple approves NFC for `pass.im.plrs.wallet` (or a new pass type ID uploaded as a DB identity).
2. The owner installs the NFC certificate.
3. The personalization fix is deployed (`docs/security.md:68`).
4. A VTAP100 passes the device checks (§8.2).

Until then:
- the designer's NFC switch is disabled with **NFC needs an approved certificate.**;
- `nfc/gate.ts` emits no `nfc` key.

The Test-a-reader dialog and the reader key flow work before approval, so a VTAP can be set up early.

### 1.5 Corrections to the inputs (decided here)

| Input says | Plan does | Why |
| --- | --- | --- |
| SA §14.4, AC §10.6: `e2e/14-scan-*.spec.ts` | `e2e/16-scan-*.spec.ts` | `14-sandbox` and `15-messages` exist |
| AC, UD, BM: `/admin/scanners` | `/admin/scanning` (SA D19) | One nav item with four tabs |
| BM §11.1: 8-digit code, polls every 3 s | 10 Crockford characters, polls every 2 s (SA §2.7) | SA wins on data |
| BM §11.2: a door card on the scanner detail page | The live event dashboard hero (SD §10.4) owns the first-check-in `cheer` and all-in `count` | SD wins on pages |
| SA §16.1 phase 3: portal `lastScan` | Later (§1.3) | SD §11 says later slice |
| SA §3.1: pairing in `routes.ts` | `routes-pair.ts` (stream SC), mounted at `/api/v1/scan` beside `routes.ts` | Avoids two streams in one file |
| SA §4.1: `scanOf` in `modules/scan/rules.ts` | `src/shared/scan-defaults.ts` | The designer needs the same defaults |
| SA §4.2: `UuidV7Schema`, `TimeZoneSchema` | Define them in `contracts/scan.ts` | Neither exists in `common.ts` |
| SA §6.1 "0014 is independent" | Keep it so. Any later scanner migration is `0018_scan_<topic>.sql`, because `0017` is reserved for n5 | `AGENTS.md` n5 row |
| SA §13.2: SPA budget 232,500 B | Measure first. Raise by at most 1 kB, with a comment in `check-bundle.ts` | Owner already accepted measured steps |
| SA §3.2: `src/shared/mask.ts` | `maskEmail` in `src/shared/email.ts` | One email module (AGENTS.md "Data") |
| SV owning `staff-session.ts` while SC owns `repo-scanners.ts` | SV gets `repo-device.ts` for the device-side `scanners` SQL | No file shared by two streams |
| SV.6 undo in M2 | Check-in undo in M1 (SV.6a) | `16-scan-door`, AD.4 and SC.4 undo check-ins in M1 |
| SD `desk/keypad` | `ui/keypad.tsx` | The staff and approval sheets load outside the desk chunk |
| Review (2026-11-04) | Asset grants, `overrideOf` validation, `unassigned` and `configRev`, mode-mismatch with no card, the all-names PIN cap, one CSP per response | SA §2.5-2.9, §5.1, §7.4, §12.2 |
| DM §10.2: `designer/scan/ops-scan.ts`, ops named `scan-*` | `designer/scan/ops-display.ts` (+ `ops-display-items.ts`), ops named `display-*` (`display-panel-add`, …) | The Scanning section already has `designer/ops-scan.ts` and `scan-action-*` ops |
| AD.6 (designer Scanning) and AD.8's designer NFC section in AD | Moved to TD (TD.1, TD.5) | One stream owns every designer file (`apply.ts`, `outline.tsx`, `model.ts` were shared) |
| DM §10.7: a preview endpoint under `/templates/{id}/scan-preview` | `GET /api/v1/scan-display/preview` in `modules/scan/routes-display.ts` (DS.5, M3) | Keeps the templates module's routes untouched |
| DM §7.2: `00NN_templates_build_key.sql` | `0018_templates_build_key.sql` (PT.7) | `0017` is reserved for n5; next free number |
| DM §2.3: snapshots in `src/passkit/template/__snapshots__/` | `src/passkit/template/scan-display/__snapshots__/` | Inside DS's folder |
| BF open item 1: Balance plus keypad doesn't fit a phone card | The phone keypad sits in a dock tray (SD §5.4) | Keeps the ledger visible; a screens-only decision |
| BF open item 3, SD vs UD: **Not found** sub | **This code isn't a pass here.** | One sub for door and desk |
| SD v1 §5.3: `Gift` glyph and **Reward ready** pill on a reached goal | The check keeps its shape; caption **1 reward ready**; **Redeem reward** promoted in the dock | The glyph shape is the verdict; no control in the card |
| AC §3.4: `NEXT_SCAN_AFTER_VERDICT` 600, decode paused during the verdict | 350, decoding resumes at T0 (SA §7.5) | B keeps the camera live; the card is upright by 350 |
| SD v1 mockups `scan-*` result tiles | Superseded by the BF sheets (SD §14) | B strengthened |
| DM drafts: 7 density units per result | 6 with frames, minus a per-screen header cost; error on `ok`, render-time cut on `heads_up` and `ready` (DM §1.6) | BF measured 434 px for 6 units under a 443 px limit; a custom title and photo cost more |
| SA draft §11: the store card adds stamps | Two blueprints: **Balance card** (Charge, Top up, Set balance on `balance`; Balance display) and a new **Stamp card** (Add stamp, Redeem reward on `stamps`; Loyalty display) | Owner, 2026-11-04. Stamps on the store card would change its passes; a new blueprint changes none |
| DM R16 (first pass): a literal band title | Literal text plus `{{holder.firstName}}` or `{{holder.name}}` only; up to 2 lines, 1 more unit | Owner, 2026-11-04 |
| BM M2: the earliest cut at T0 + 600 | T0 + 350 (BM M2 fixed) | The head shake was designed for a 350 cut; SA §7.5 already said 350 |
| SA §13.2: `renderScanDisplay` as a forbidden bundle marker | String sentinels `scan-display:render` and `SCAN_DISPLAY_DENSITY` | `check-bundle.ts` matches literal text; function names are minified |
| SA §2.6 "only `template.name`" with no field for it | `ScanOutcome.template: { name, style } \| null` (C1) | The live/test row needs the name and nothing from the pass |
| e2e: the VIP and coffee displays on "a template" | Coffee and prepaid use the Stamp card and Balance card blueprints as shipped; VIP, door 01 and gym are fixture templates made by `e2e/helpers/scan-templates.ts` from DS.2's `examples.ts` (IN.1) | No blueprint has section, row, gate or tier inputs |

---

## 2. Phase 0: the access model and frozen contracts

Everything depends on P0. P0 is one stream (lead: the integration agent, plus one access engineer), one branch
`next/n8-p0`, and one merge. When it merges, behaviour is unchanged: `denyAllStores.scanners` resolves null, and the
routers are mounted but empty.

### 2.1 The access model in one page (SA §2)

- **No org membership this wave.** The console stays platform-admin only (`requireAdmin`). SA §2.10 is the later seam.
- **Principals on scan routes:**
  - **`scanner`** (new `AuthContext` kind). Either a browser device with the cookie `__Host-wallet_scan`, or a till
    with `Bearer wls_<8>_<43>`. It covers one org, one mode and `/api/v1/scan/*` only.
  - **Admin session.** "Scan as admin": Manager rights, and it picks an org per request.
  - A user session gets 403. API keys never act; they get `scans:read` for the feed only.
- **`ScanActor`** (`modules/scan/guard.ts`): every scan service takes this one normalized shape (SA §2.5).
- **Staff.** These are org people with no platform account: a name, a role and a 6-digit PIN. The PIN is stored as
  `HMAC(K_pin, id:pin)`, where `K_pin = derivedHmacKey(env, 'scan-pin')`.
  - Roles form a ladder **door ⊂ desk ⊂ manager**.
  - A scanner runs as its `roleWithoutSignIn` (door or desk, never manager), or requires staff sign-in.
  - A Manager PIN approves one action in place.
- **Rights.** The role must be at least the action's `minRole`, and the amount at most the action's `max`. Above
  either, the answer is heads-up `needs_approval`. `scanPolicy` in `modules/scan/rules.ts` is the only place that
  decides. Routes never check roles.
- **Guard order** (SA §2.5):
  1. credential;
  2. org active;
  3. `RL_SCAN_ORG`, then `RL_SCAN`;
  4. staff binding.
- **Outcome order:** steps 5-16 of SA §2.6. They return 200 with an outcome.
- **CSRF.**
  - Scanner cookie: same origin, plus `x-csrf-token` equal to the scanner's `csrf_secret`.
  - Bearer: exempt.
- **Rate limits.** `RL_SCAN_PAIR` 1010, `RL_SCAN` 1011, `RL_SCAN_LOOKUP` 1012, `RL_SCAN_ORG` 1013. D1 counters per
  SA §2.9.
- **Audit.** The `audit_log` CHECK gains `scanner` (a safe rebuild in `0014`). The actions are listed in SA §2.11.

### 2.2 P0 tasks (in order, one branch)

**P0.1 Migration `0014_scan.sql`**
- **Files:**
  - `migrations/0014_scan.sql`, exactly SA §6.1;
  - `test/migrations.test.ts`, a new `describe('0014_scan')`;
  - `test/query-plans.test.ts`;
  - `src/worker/modules/audit/types.ts`: `AuditActorType` gains `'scanner'`.
- **Tests first:**
  - all eight tables exist (`scan_events`, `scan_event_templates`, `scan_staff`, `scanners`, `scanner_templates`,
    `scans`, `scan_gates`, `vas_keys`), plus `passes.lookup_hash`;
  - the existing "indexes every foreign key child column" test passes;
  - an `audit_log` insert with `actor_type = 'scanner'` succeeds;
  - `audit_log` keeps the indexes `audit_org`, `audit_target`, `audit_at`, `audit_actor` and `audit_action`;
  - `scan_gates` is `WITHOUT ROWID` with PK `(pass_id, action_id, scope)`;
  - CHECKs reject: a bad mode, `closes_at <= opens_at`, a terminal with a `csrf_secret`, a `match_input` without
    `match_values`, and a `scan_events.note` over 140 characters;
  - the partial index `scans_pass_ok` exists with `WHERE outcome = 'ok'`.
- **Done when:**
  - `npm run db:local` applies `0014` on a database that already has `0016`;
  - the migration test passes on a fresh database;
  - no other migration on the branch touches `audit_log` (integration checks this at every merge until `0014` lands).

**P0.2 Contracts, copy and shared pure helpers** (frozen at merge; changes follow §4.1)
- **Files:**
  - **New:**
    - `src/shared/contracts/scan.ts` (SA §4.2, plus `UuidV7Schema`, `TimeZoneSchema` (IANA, validated with `Intl`),
      `milestone` on `ScanOutcome`);
    - `src/shared/contracts/scanners.ts` (SA §4.3);
    - `src/shared/contracts/nfc.ts` (SA §4.4);
    - `src/shared/copy/scan.ts`, `SCAN_COPY` with every headline, sub and action label of SD §5, and the display's
      system captions (DM §3.5: **{n} more for {reward}**, **{n} reward(s) ready**, **Changed elsewhere**, **No
      photo**, **Low balance**, **No visits yet.**, **Cut on this screen** for the editor);
    - `maskEmail` in `src/shared/email.ts` (beside `normalizeEmail`; one email module, foundation file);
    - `src/shared/scan-lookup.ts`, `normalizeLookup`;
    - `src/shared/scan-defaults.ts`, `scanOf(manifest)`, the defaults table of SA §4.1;
    - `src/passkit/template/scan-display/schema.ts` (DM §6.2: `ScanDisplayDocSchema` and every authored schema, zod,
      `.strict()`), `src/passkit/template/scan-display/icons.ts` (`SCAN_ICONS`, 40 ids, no React);
    - `src/shared/contracts/scan-display.ts`, the rendered `ScanDisplaySchema` (DM §5.5, with `identity`, `oneLine` and `header.titleLines`);
      it imports only `icons.ts` from passkit, never `schema.ts` (the authored schemas stay out of `/scan`);
    - `src/passkit/template/scan-display/index.ts` with C16's signatures as stubs (`renderScanDisplay` returns the
      identity-only display, `scanDisplayIssues` returns `[]`), so PT, SV and TD can build before DS.1; DS owns it after
      P0.
  - **Edited:** `src/shared/contracts/index.ts` (re-exports). `contracts/scan.ts` per SA §4.2 as revised:
    `ScanCard.display`, `ScanOutcome.display`, `ScanOutcome.template` (`{ name, style } | null`),
    `ScanSession.event.note`; no `photoUrl` or `identityFields` on the card.
    `contracts/scanners.ts`: `ScanEvent.note`.
  - **Edited per SA §4.5, except `me.ts`:**
    - `common.ts`: `scans:read`;
    - `events.ts`: kinds `scan.checked_out`, `scan.heads_up`, `scan.undone`, and the group `scans`;
    - `settings.ts`: `retention.scansDays`, `scan.undoWindowMinutes`, `scan.lookupsPerHour`, `nfc.enabled`;
    - `broadcasts.ts`, `passes.ts`: `scan?: ScanTargetSchema`;
    - `metrics.ts`;
    - `identities.ts`: `nfcKeys`.
  - **Edited:** `src/passkit/types.ts`, adding `ScanAction`, `ScanManifest` (with `display?: ScanDisplayDoc`, without
    `values` and `identity`) and `NfcManifest`, the optional `TemplateManifest.scan` and `.nfc`, and the display types
    re-exported as `z.infer` of the schemas so passkit callers don't import zod.
- **Tests first:**
  - a parse round trip of a fixture for every schema;
  - `copy.test.ts`: every `ScanReasonSchema` value and every client reason (`network`, `timeout`, `unconfirmed`,
    `still_unconfirmed`, `server`, `rate_limited`, `saved_offline`, `add_link`) has a headline and a sub;
  - `maskEmail('anna@gmail.com') === 'a•••@g•••.com'`;
  - `normalizeLookup('12-34 56') === '123456'`, plus NFKC and case;
  - `scanOf`: no block gives one `check_in`; every per-kind default in SA §4.1;
  - `ScanActRequestSchema` rejects an unknown key;
  - every DM §8 example doc parses with `ScanDisplayDocSchema`; a `columns` row with 5 items, an `image` with
    `source: 'photo'` and an unknown key are refused with the right path; a fixture `ScanDisplay` per screen parses.
- **Done when:** typecheck passes on both web and worker, and n6/n7 tests still pass.

**P0.3 Platform principal** (foundation files)
- **Files:**
  - `src/worker/platform/auth.ts`: `ScannerAuth`, `SCANNER_COOKIE`, `SCANNER_TOKEN`, `ScannerStore`,
    `AuthStores.scanners`, `denyAllStores`;
  - `src/worker/platform/csrf.ts`;
  - `src/worker/platform/context.ts`: `Actor` gains scanner;
  - `src/worker/platform/denied.ts`;
  - `src/worker/platform/crypto.ts`: `derivedHmacKey(env, label)`;
  - `src/worker/platform/env.ts`: `RATE_LIMITS`;
  - `wrangler.jsonc`: ratelimits 1010-1013;
  - `src/worker/platform/analytics.ts`: `EventName` gains `scan.result`;
  - `src/worker/modules/passes/{service,http}.ts`: `Actor` gains `scanner`; `actorFor` passes it through;
    `orgScopeOf` returns the scanner's org (owner d, told in the report).
- **Tests first:**
  - a scanner `AuthContext` fails `requireSession`, `requireAdmin` and `requireApiKeyOrAdmin`;
  - a `wls_…` bearer on `/api/v1/passes` gives 401;
  - CSRF: scanner cookie plus wrong or missing `x-csrf-token` gives 403; the bearer is exempt;
  - `assertOrgAccess` refuses another org;
  - `derivedHmacKey` is stable per label and differs across labels;
  - a missing `RL_SCAN*` binding gives 503;
  - `reportDenied` records actor type `scanner`.
- **Done when:** all existing auth tests pass unchanged.

**P0.4 Access core** (`modules/scan`, the access engineer)
- **Files:**
  - `src/worker/modules/scan/`:
    - `auth-store.ts`, `createScannerStore(env)`: by prefix, then `safeEqual` on the hash; touches `last_seen_at`
      and `last_ip_prefix` at most every 60 s; no isolate cache;
    - `repo-device.ts` (SV after P0): the device side of the `scanners` row: get by prefix, touch, staff bind,
      unbind and expiry. Console CRUD SQL lives in SC's `repo-scanners.ts`, so the two streams never share a file;
    - `repo-staff.ts`: get, list active managers of an org;
    - `staff-pin.ts`: hash, verify, lockout counters `scan:pin:<scannerId>:<staffId>` (5 per 5 min) and
      `scan:pinall:<scannerId>` (20 misses per hour, any name; audit `scanner.pin_flood` once);
    - `guard.ts`: `requireScanActor`, `ScanActor`, admin scope from `ScanAdminScopeSchema`;
    - `rules.ts`: `effectiveRole`, `ROLE_RANK`, and `scanPolicy` for role, `max`, `letInAgain`, the undo window and
      the action-above-role rows of SA §2.4 Matrix B. Pure; the value-action parts are added by stream SV.
  - `src/worker/stores.ts`: wire `scanners` (owner e).
  - `test/helpers/fake-auth.ts`: `fake.scanner({ orgId, mode, settings, accepts, staff?, transport })`.
  - `test/helpers/count-d1.ts`: a D1 wrapper that counts round trips, for SA §13.1.
- **Tests first:**
  - guard order SA §2.5: revoked gives `SCANNER_REVOKED`, expired gives `SCANNER_EXPIRED`, a suspended org gives
    `ORG_INACTIVE` (403), a user session gives `FORBIDDEN`, nothing gives `SCANNER_UNAUTHENTICATED`;
  - `staffSignIn` on and nobody bound gives `STAFF_REQUIRED`, except on `GET /scan/session`, `POST /scan/staff` and
    `POST /scan/unpair`;
  - the staff binding expires at 15 min idle and at 12 h;
  - scanner cookie and admin session together: the scanner wins;
  - effective role per SA §2.2;
  - every Matrix B row as a pure `scanPolicy` case;
  - a PIN works only for the same org's scanner;
  - 5 misses lock that person on that scanner and audit `scan_staff.pin_locked` once; 20 misses across names lock
    every PIN on that scanner for the hour;
  - a scanner request with `scope` gives 422 `SCAN_SCOPE_NOT_ALLOWED`; an admin scope naming another org's event or
    template gives 404 with an unknown id's body;
  - no log line contains a PIN or a token (a log spy).
- **Done when:** `requireScanActor` on a test router admits `fake.scanner()` and `fake.admin()` with a scope.

**P0.5 The `/scan` document and headers** (foundation and integration files)
- **Files:**
  - `scan.html`, per AC §1.1;
  - `src/web/scan/main.tsx`: a stub that renders an empty `ScanApp` placeholder (stream CC owns it after P0);
  - `public/scan.webmanifest`;
  - `vite.config.ts`: second input `scan: 'scan.html'`, and `'!/scan'` in `VITE_DEV_PATHS`;
  - `tools/check-bundle.ts` and its test: `SCAN_BUDGET_BYTES = 150_000`, a second run over `dist/client/scan.html`,
    and forbidden markers `routeTree`, `__passbookScan`, `scan-display:render` and `SCAN_DISPLAY_DENSITY` for the scan
    entry (literal strings; `FORBIDDEN` matches text, so identifiers can't be markers). The last two are also forbidden
    in the SPA initial;
  - `knip.json`: entries `scan.html` and `src/web/scan/camera/decode-worker.ts`;
  - `package.json`: `zxing-wasm` `3.1.6`, exact;
  - `public/_headers` and `src/worker/platform/security-headers.ts` (+ test), per SA §12.2 and AC §1.4:
    `SCAN_PERMISSIONS_POLICY`, `scanContentSecurityPolicy()`, `/scan` in `NO_REFERRER_PREFIXES`, and the worker CSP
    on `/assets/decode-worker-*` only (`vite.config.ts` gives the worker that fixed file-name prefix);
  - `wrangler.jsonc` `run_worker_first` gets `!/scan.webmanifest`, with `tools/wrangler-config.test.ts`;
  - `src/web/lib/chunk-reload.ts`, moved out of `src/web/main.tsx`.
- **Removals and renames:**
  - delete `src/web/routes/scan.tsx`, `src/web/scan/scan-page.tsx`, `src/web/admin/scanners/` and
    `src/web/routes/admin/scanners/`;
  - drop `/scan` from `isPublicPath` (`src/web/lib/guards.ts`);
  - nav item **Scanners** becomes **Scanning** at `/admin/scanning`, with a placeholder
    `src/web/routes/admin/scanning/index.tsx` (empty state).
- **First, before writing anything:** find which layer serves `/scan` (the asset layer, or the Worker's `spaPage()`
  under `run_worker_first: "/*"`), and therefore which headers apply. Write the answer in the PR.
- **Tests first:**
  - `security-headers.test.ts`: `/scan` has `camera=(self)`, `'wasm-unsafe-eval'` and `worker-src 'self'`; every
    SPA path keeps `camera=()`; `_headers` and the code agree;
  - `/scan` and `/assets/decode-worker-*` carry **exactly one** `Content-Security-Policy` and one
    `Permissions-Policy` header: their `_headers` blocks detach the `/*` values with `! Content-Security-Policy`,
    `! Permissions-Policy` (and `! Referrer-Policy` on `/scan`) before setting their own (SA §12.2). Cloudflare merges
    matching rules, and two CSPs are both enforced, which would block the wasm;
  - `check-bundle.test.ts`: the scan run fails over budget and on `routeTree`;
  - the guard test: `/scan` is no longer public in the SPA guard.
- **Done when:**
  - `vite build` emits `dist/client/scan.html` [U: the Cloudflare plugin builds two HTML inputs; if not, stop and
    tell the lead];
  - the SPA initial size is measured and written in the PR (raise ≤ 1 kB with a comment only if over);
  - the scan initial size is ≤ 150 kB;
  - `npm run dev` serves `/scan` from `scan.html`.

**P0.6 Skeleton, mounts and client contracts**
- **Worker files:**
  - `src/worker/modules/scan/`: `routes.ts` (`scanRoutes`), `routes-pair.ts` (`scanPairRoutes`),
    `routes-scanners.ts` (`scannersRoutes`), `routes-events.ts` (`scanEventsRoutes`), `routes-staff.ts`
    (`scanStaffRoutes`), `routes-scans.ts` (`scansRoutes`), `routes-display.ts` (`scanDisplayRoutes`), `jobs.ts` (three
    no-op hooks);
  - `src/worker/modules/scan/display.ts` with C17's signatures as a stub (`buildDisplay` returns an identity-only
    display for a known pass, holder = the pass title, and `null` otherwise; `historyStatements` returns no statements); DS owns it after P0;
  - `src/worker/modules/nfc/routes.ts` (`nfcRoutes`);
  - `src/worker/app.ts`: mounts `/api/v1/scan` (scan and scan-pair), `/api/v1/scanners`, `/api/v1/scan-events`,
    `/api/v1/scan-staff`, `/api/v1/scans`, `/api/v1/scan-display`, `/api/v1/nfc`;
  - `src/worker/jobs/cron.ts`: hooks `scan.reconcile` (minute), `scan.backfill` (minute), `scan.retention` (daily).
- **Web files (the frozen client contract):**
  - `src/web/scan/machine/types.ts`: state, events, commands, outcome and `Presentation`, from AC §3.1-3.3 with SA
    §7.5's amendments (block `'staff'`, approval, `stale`) and the B card layer: `card: { phase, id, kind } | null`,
    commands `card.rise | card.tuck | card.swap`, the `held` state, `Presentation.{tint, dim, dock, card}`, and
    `view.buddy` without `seat` but with `card: 'in' | 'out'`;
  - `src/web/scan/timing.ts`: `SCAN_TIMING` from AC §3.4, with `BEAT_DELAY 150`, `BEAT_MAX 550`,
    `NEXT_SCAN_AFTER_VERDICT 350`, `CARD_RISE 380`, `CARD_TUCK 180`, `CARD_SWAP_TUCK 150`, `DESK_DIM 200`,
    `COMMIT_ARM 260` (SA §7.5);
  - `src/web/scan/machine/fixtures.test-support.ts`: builders for every state of AC §3.5 plus the card phases, the
    desk panel faces and `held`, each with a fixture `ScanDisplay` from DM §8, so the UI streams can render without a
    store;
  - `src/web/scan/input/types.ts`: `RawRead` and `ScanInput`.
- **Docs files:**
  - `AGENTS.md`: replace the n8 row with the stream rows of §3;
  - `docs/design/next-wave.md`: point §n8 at the scanner docs.
- **Tests first:**
  - every new router answers 404 for unknown paths;
  - the OpenAPI document still builds;
  - the cron hooks run inside the budget.
- **Done when:** behaviour is unchanged, and `npm run check` is green.

**P0.7 Design docs into the repo**
- Copy `scanner-architecture.md`, `scanner-design.md`, `buddy-motion.md`, `arch-client.md`, `ux-door.md`,
  `ux-desk.md`, `ux-admin.md`, `docs/design/scanner/display-model.md` and this plan into `docs/design/scanner/`.
- Copy `docs/design/scanner/b-final.md` to `docs/design/scanner/b-final.md` and `docs/design/scanner/b-final/*.png` into
  `docs/design/scanner/b-final/`: the visual source of truth for `/scan`.
- Copy `docs/design/scanner/display/*.png` into `docs/design/scanner/display/`: the source for the Scan screen editor.
- Copy `buddy-draft/{beats.css,props.tsx,sound.ts}` into `docs/design/scanner/buddy-draft/`. They are a reference,
  not built.
- Copy only the `admin-*` mockup sheets (`docs/design/scanner/mockups/admin-*.png`) into `docs/design/scanner/mockups/`, after
  regenerating **Admin 01 Pairing** and **Admin 03 Designer** for SD §14's two fixes. The `scan-*` sheets are
  superseded and not copied.
- Every later reference in this plan means the copy in `docs/design/scanner/`.

**P0 exit:** `npm run check` is green, `0014` applies, and the contracts, the client types and the routers exist.
Every stream can start.

---

## 3. Workstreams and owned paths

Nine streams run in parallel after P0. No two streams own the same file, and no file is a shared touch of two
streams. Unlisted files belong to their usual `AGENTS.md` owner, and need a request.

| Stream | Owns (after P0) | Shared touches (additive, reported) |
| --- | --- | --- |
| **P0 lead** (integration) | `migrations/0014_scan.sql`, `src/shared/contracts/{scan,scanners,nfc,scan-display}.ts`, `src/passkit/template/scan-display/{schema,icons}.ts`, `src/shared/copy/scan.ts`, `src/shared/{scan-lookup,scan-defaults}.ts`, `src/web/scan/{machine/types,timing,input/types}.ts`, `scan.html`, `public/scan.webmanifest`. Changes only through the §4.1 contract PR | foundation files (`platform/*`, `_headers`, `wrangler.jsonc`, `vite.config.ts`, `src/shared/email.ts`), `src/passkit/types.ts` (a2, P0.2 only) |
| **SV** scan server, device API | `src/worker/modules/scan/{routes,guard,rules,auth-store,staff-pin,staff-session,resolve,act,effects,undo,group,lookup,outcome,counts,assets,roster,batch,jobs,dto,repo-device,repo-scans,repo-gates,repo-lookup,repo-counts}.ts` and their tests | none |
| **SC** scan server, console | `src/worker/modules/scan/{routes-pair,routes-scanners,routes-events,routes-staff,routes-scans,pairing,scanners,events,staff-admin,feed,live,dto-console,repo-scanners,repo-staff,repo-events,repo-target}.ts` | `modules/metrics/{repo,analytics-sql,service}.ts` (g) |
| **DS** display | `src/passkit/template/scan-display/**` except `schema.ts` and `icons.ts` (validate, scope, condition, format, render, density, needs, presets, defaults, migrate, sample, snapshots), `src/worker/modules/scan/{display,repo-history,routes-display}.ts` and their tests | none |
| **PT** passes, templates, NFC server | `src/worker/modules/nfc/**`, `src/passkit/template/scan.ts`, `src/shared/pass-view/validity.ts`, `migrations/0018_templates_build_key.sql` | `modules/passes/{publish,repo-write,builder,create,repo-list}.ts` (d); `src/passkit/template/manifest.ts` (a2); `templates/starter-*` (a2); `modules/templates/package/{manifest,manifest-rules}.ts`, `modules/templates/{persist,repo-stale,versions}.ts`, `src/shared/contracts/templates.ts` (c); `src/shared/pass-view/normalize.ts`, `src/web/pass-card/*` (b); `src/web/admin/passes/pass-preview.tsx` (i); `modules/identities/*` for the `identity.nfc_change` audit (n2) |
| **CC** scan client core | `src/web/scan/{main.tsx,machine,input,camera,platform,api,offline,dev}/**` (except the P0 files), `src/web/scan/boot/{use-scan-session,pair-link}.ts` | `vite.config.ts` (the v3 service-worker emit only, via integration) |
| **UI** scan screens (visual direction) | `src/web/scan/{app.tsx,ui,result,display,lookup,desk}/**`, `src/web/scan/boot/*.tsx` | `src/web/ui/code-field.tsx` (moved from `src/web/portal/code-field.tsx`; h0, j) |
| **BU** buddy, sound, art (visual direction) | `src/web/scan/{buddy,sound}/**` | `src/web/ui/art/{buddy,buddy-art,replay,registry}.ts(x)`, entity art files and `scenes/*` (h0); `src/web/ui/art/art.test.tsx` budgets (h0); `src/web/lib/gaze.ts` (new, h0) and its callers `src/web/portal/login-{scene,email-face}.tsx` (j) |
| **AD** admin | `src/web/admin/scanning/**`, `src/web/routes/admin/scanning/**` | `src/web/admin/identities/{nfc-card,reader-key-dialog,reader-test-dialog}.tsx` + `identity-cards.tsx` switch removal (n2); `src/web/admin/passes/detail/{sync-tab,sync-model}.ts(x)` (n1); `src/web/admin/passes/` list filters (i); `src/web/admin/overview/*` (h); `src/web/admin/messages/{audience,composer-state}.tsx` (n7); `src/web/admin/audit/labels.ts` (h); `src/web/admin/settings/*` Scanning group (h); `src/web/lib/{nav,entities,status,actions,confirms}.ts` (h0) |
| **TD** template designer | `src/web/admin/templates/designer/scan/**` (the Scan screen mode, DM §10.2) | `src/web/admin/templates/designer/{section-scan,ops-scan,section-nfc,ops-nfc,model,apply,reducer,targets,outline,designer,designer-page,api,section-inputs}.ts(x)` and `designer.test.ts`, `designer-ui.test.tsx` (n5); `src/web/admin/templates/{template-overview,versions-panel}.tsx` (i) |
| **IN** integration | `e2e/16-scan-*.spec.ts`, `e2e/helpers/scan.ts`, `e2e/fixtures/{make-y4m.ts,scan-qr.y4m}`, `e2e/helpers/scan-templates.ts`, `playwright.config.ts`, `tools/e2e-server.ts`, `docs/{api,operations,security}.md`, `docs/design/motion-and-expression.md`, foundation files after P0 | — |

**The visual direction is isolated in UI and BU.** Geometry, z-order, type steps, colour tokens and motion (BF) live
only in `src/web/scan/{ui,result,display,desk,buddy}/**`. DS, CC, SV, SC, PT and TD carry content, order and the
`oneLine` hint, never a size or a colour: a DS test fails on any `px`, `rem`, `#hex` or `rgb(` literal in
`scan-display/**`, and CC's `Presentation` names layers and phases, not positions. Switching to "A at the door, B at
the desk" later is a UI + BU change: the door's result view and the buddy seat. TD's canvas imports UI's display
painter, so it follows the direction with no TD change.

**Rules between streams:**
- **Read-only imports across streams are fine.** For example: SC's console undo calls SV's `undo.ts` service; AD's
  Test-a-reader imports CC's `input/wedge-detector.ts` (pure); PT's `repo-list.ts` imports SC's `repo-target.ts`.
- **A cross-stream import goes one way only.** `modules/nfc` never imports `modules/scan`. `modules/passes` imports
  only `scan/repo-target.ts`, which imports nothing from `passes`.
- **Art.** BU owns every `ui/art` change, including the admin entity art (`scanner`, `stub`, `badge`). AD consumes the
  art by name.
- **Display.** DS owns the pure model and the server display; SV calls `buildDisplay` (C17) from `outcome.ts` and
  adds `historyStatements` to its batches; UI paints `ScanDisplay` (C15) and TD edits `ScanDisplayDoc` with DS's pure
  functions (C16). `src/passkit/template/scan-display/**` never imports from `src/worker` or `src/web`.

---

## 4. Cross-stream contracts (fixed up front)

### 4.1 The frozen list

| # | Contract | Lives in | Fixed by | Consumers |
| --- | --- | --- | --- | --- |
| C1 | Wire schemas: device API, console API, NFC, reasons, `ScanCard` (with `display`), `ScanOutcome` (with `display`), `ScanSession` (with `event.note`) | `src/shared/contracts/{scan,scanners,nfc}.ts` | P0.2 | SV, SC, PT, CC, UI, AD, DS |
| C2 | Copy: every reason's headline, sub and actions | `src/shared/copy/scan.ts` | P0.2 | UI, AD, SC (CSV) |
| C3 | Manifest types and defaults: `ScanManifest` (with `display`), `NfcManifest`, `scanOf` | `src/passkit/types.ts`, `src/shared/scan-defaults.ts` | P0.2 | PT, SV, DS, TD |
| C4 | Principal: `ScannerAuth`, `ScannerStore`, `ScanActor`, `requireScanActor`, `fake.scanner` | `platform/auth.ts`, `modules/scan/guard.ts`, `test/helpers/fake-auth.ts` | P0.3-4 | SV, SC |
| C5 | Publish hook: `PublishOptions.commit?: (w: { objectKey: string; version: number }) => D1PreparedStatement[]`. `casPublish` runs `db.batch([casUpdate, ...commit(w)])`. Each hooked statement guards itself with `EXISTS (SELECT 1 FROM passes WHERE id = ? AND object_key = ?)` | `modules/passes/publish.ts` | PT.1 (first PT merge) | SV.5 |
| C6 | Validity: `validityOf(passJson, now) → { status: 'active' \| 'voided' \| 'expired', validFrom, validUntil }` | `src/shared/pass-view/validity.ts` | PT.1 | SV.1, UI |
| C7 | Lookup keys: `lookupHashOf(value) = sha256hex(normalizeLookup(value))`, written on every publish when `manifest.scan.lookup` is set | `modules/passes/builder.ts` | PT.1 | SV.1 |
| C8 | NFC gate: `nfcDictionary(ctx, { identity, orgId, manifest, scanCode, removed }) → PassNfc \| null` | `modules/nfc/gate.ts` | PT.6 | `passes/builder.ts` |
| C9 | Scan target SQL: `scanTargetWhere(target: ScanTarget, alias: string) → { sql, params }` | `modules/scan/repo-target.ts` | SC.6 | PT.5, broadcasts (through `passFilterSql`) |
| C10 | Client machine: `ScanState` (with the card layer and `held`), `ScanEvent`, `ScanCmd` (with `card.rise`/`tuck`/`swap`), `Presentation` (`tint`, `dim`, `dock`, `card`, `buddy`), `SCAN_TIMING` (SA §7.5); `useScanMachine(): { state, view: Presentation, dispatch }`; `bus.emit(RawRead)` | `src/web/scan/{machine/types,timing,input/types}.ts` | P0.6; the hook and bus in CC.1-2 | UI, BU |
| C11 | Buddy beat API on `Buddy`/`BuddyArt`: `beat`, `pose`, `dir`, `landed`, `immediate`, prop slots `onCard`/`front`/`aside` (BM §2.1); the `xl-scan` size tier and `card?: 'in' \| 'out'` (hides the violet pass, shows the pocket notch); `ScanBuddy` with no props, reading `beat`, `pose`, `mood`, `key` and `card` from `view.buddy` (one dock seat) | `src/web/ui/art/*`, `src/web/scan/buddy/scan-buddy.tsx` | BU.1, BU.3 | UI |
| C12 | Sound: `sound.unlock()` (sync, in a tap handler), `sound.play(chirp, { garnish?, at? })`, `sound.cut()`, `sound.setEnabled(bool)` | `src/web/scan/sound/player.ts` | BU.2 | UI, CC (commands) |
| C13 | e2e hook: `window.__passbookScan.read({ method, code })`, dev builds only, armed by `window.__passbookScanTest = true` | `src/web/scan/dev/test-hook.ts` | CC.5 | IN |
| C14 | Stable `data-testid`s: `scan-verdict` (the result card, with `data-kind`, `data-reason`, `data-screen`, `data-phase`), `scan-count`, `scan-last` (the dock strip), `scan-recent-row`, `scan-start`, `pair-code`, `desk-panel`, `action-area`, `dock-primary`, `keypad`, `staff-sheet`, `approval-panel`, `display-panel` (with `data-panel-id`), `display-row` (with `data-row-id`, `data-type`) | UI components | UI.2 | IN, TD |
| C15 | Display contracts: authored `ScanDisplayDocSchema` and friends, `SCAN_ICONS`; rendered `ScanDisplaySchema` | `src/passkit/template/scan-display/{schema,icons}.ts`, `src/shared/contracts/scan-display.ts` | P0.2 | DS, SV, UI, TD, PT |
| C16 | Display functions (pure, browser and worker): `renderScanDisplay(doc, scope, { screen, role, terminal?, locale, timeZone, now, actionId?, amountOpen? }) → ScanDisplay` (`terminal` drops panels; `ScanRole` has no terminal value); `scanDisplayIssues(manifest, { passJson, assetNames }) → Issue[]`; `defaultScanDisplay(manifest, passJson)`; `PRESETS`; `density(doc)`; `compileNeeds(doc)`; `scopeCatalog(manifest, role)`; `sampleScope(manifest, overrides)` | `src/passkit/template/scan-display/index.ts` | DS.1-DS.2 (signatures stubbed in P0.2 so TD and PT can start) | TD, PT, SV (through C17) |
| C17 | Server display: `buildDisplay(ctx, { actor, pass, card, template, screen, scan, history }) → ScanDisplay \| null` (never throws); `historyStatements(db, needs, { passId, orgId, timeZone, now }) → { stmts: D1PreparedStatement[], read(results) }` | `src/worker/modules/scan/display.ts`, `repo-history.ts` | DS.3 | SV.1, SV.2 |
| C18 | Display painter: `<DisplayPanels display width />`, `<ResultCard outcome card display session />`, `<IdentityRow />`, one component per row type, `scanIcon(id)` | `src/web/scan/{display,result}/*` | UI.6 | UI, TD (canvas) |
| C19 | Save version: `SaveVersionRequest.activate: boolean \| 'display-only'`; `SaveVersionResponse.{activated, displayOnly}`; `TemplateVersionSchema.displayOnly` | `src/shared/contracts/templates.ts` | PT.7 | TD |

**Changing a frozen contract.**
1. Open a PR against `next/integration` that changes only the contract file and its tests.
2. The P0 lead merges it.
3. Every consumer rebases.

Additive optional fields need no notice. Renames and removals need every consumer's ack in the PR.

### 4.2 Behaviour fixed up front (no stream re-decides)

- **Reasons and kinds.** The reason list is SA §4.2. `ok` / `heads_up` / `refused` / `ready` return 200. HTTP errors
  are SA §2.8 only.
- **Idempotency.**
  - A UUIDv7 key per request, unique per `actor_key`.
  - A replay gives `replay: true` and the same `scanId`.
  - Overrides and approvals send a **new** key: with `overrideOf` for overrides, and with `approval` for approvals.
- **Timing.**
  - Tint, ring, band colour and chirp land at T0 in one frame; the card is upright by T0 + 210 and at rest by 380.
  - The beat starts at T0 + 150 and is still by T0 + 700.
  - The camera keeps decoding during results; a different code is accepted at T0 + 350 and swaps the card.
  - The ok hold is 1.2 s at the door; at the desk the card stays up untinted after it (SA §7.5).
  - The same code is ignored for 5 s after ok and 30 s after a refusal.
  - The request timeout is 5 s.
  - `Unsure` retries run every 10 s for 2 min.
- **Push.**
  - Check-in publishes nothing.
  - Value actions publish with `notify: false` unless the action sets `notify: true`.
  - Undo is always silent.
- **Mode.**
  - The scanner's mode is bound server-side.
  - A test pass on a live scanner gives `test_pass`; a live pass on a test scanner gives `live_pass`.
  - `pass_events.mode` comes from the pass.
- **Security.**
  - The org predicate goes inside every lookup statement.
  - Another tenant's code gets a body identical to a random code's except `scanId` and `at`.
  - Another mode's pass gets `test_pass`/`live_pass` with no card.
  - Assets need a 1 h grant bound to the actor; `overrideOf` is validated (SA §2.6).
  - No email (except masked in search rows), phone, barcode, scan code, `serialNumber`, `authenticationToken`,
    `webServiceURL` or download token in any scan DTO, and none of them in any display scope, for any role.
- **Display** (SA §4.6, DM §1.11).
  - The verdict (tint, ring, band, glyph, headline, sub, hold rail, sound, buddy) is system-only; its copy is
    `SCAN_COPY` ("+2 stamps", "Voided Nov 3.", milestones add no words).
  - `heads_up` takes no custom icon or title; `refused` takes only `notes.refused`; system screens have
    `display: null`.
  - The holder line always shows; `header.subtitle` is an extra meta line under it; `holder` is one path.
  - `header.title` is literal text plus, at most, the holder's name (`{{holder.firstName}}` or `{{holder.name}}`, no
    other binding), or a plural; ≤ 2 lines (28 graphemes), and a title that can take 2 lines costs 1 more unit; a
    verdict word in the literal part is an error; a name token needs a `holder` source that can hold a name (a string
    input without `enum`, or a field); at render the name must be 1-3 words of letters with no verdict word, else the
    title is empty and the band shows the system headline (DM §1.3); `heads_up` and `refused` keep the system headline.
  - Density: 6 units per result with frames, minus the per-screen header cost (DM §1.6); `ok` over is a save error;
    `heads_up` and `ready` are cut at render; overflow at paint time scrolls the body under a fixed band.
  - The result card paints `ScanOutcome.display` only; the desk panel paints `ScanCard.display`.
  - Mode mismatches carry `card: null`, `display: null` and `template` (name and style) only.
  - Slot order: band → identity row (tile or photo, holder line, meta, flags and chips) → panels → notes.
  - No control in any display; actions, the stepper, keypad, review, PIN, Undo, Let in again, Done and the promoted
    redeem live in the system action area.
  - Role filtering happens before evaluation; a render error falls back and never fails a scan.
  - A display-only save activates at once and moves no pass.

---

## 5. Task lists per stream

Each task gives the milestone (M1-M5), what it depends on, its files, what to build, the tests to write first, and
when it is done. Unless noted, file names follow SA §3 and AC §8. A task may split a file into `-<topic>.ts` to stay
under 300 lines.

### 5.1 SV: scan server, device API

**SV.1 Resolve and the card** (M1; needs P0, PT.1; the `display` call needs DS.3)
- **Files:** `resolve.ts`, `repo-lookup.ts`, `outcome.ts`, `dto.ts`, `assets.ts`, `routes.ts` (`POST /resolve`,
  `GET /session`, `GET /stats`, `GET /passes/{passId}/assets/{name}`).
- **Build:**
  - server normalisation (SA §8.3): `codeKey`, `barcodeHash`, `lookupHash`;
  - candidates: scan code, then barcode hash (LIMIT 5), then lookup hash (LIMIT 5), then manual only (external id,
    serial, `passId`). Always `org_id = ? AND deleted_at IS NULL`;
  - narrowing in the order of SA §2.6 steps 5-13;
  - `ScanCard` (SA §4.2), with the stripped `passView` and assets through the scanner route, `values` derived from
    action inputs, and `display` for screen `ready` from `buildDisplay` (C17), its `historyStatements` in the card-read
    batch. Until DS.3 merges, the P0.6 stub gives an identity-only display;
  - `ScanSession` with `state` (including `unassigned`), `templates`, `formats`, `counts` (with `configRev`) and
    `csrfToken`;
  - mode mismatch (`test_pass`, `live_pass`) answers with `card: null`, `display: null` and `template: { name, style }`
    only; every other found pass also sets `template`;
  - the asset route serves an image only with a valid grant `g` for this actor and pass (SA §5.1 "Asset grant",
    `derivedHmacKey(env, 'scan-asset')`, 1 h). Cards and lookup rows carry it; a `ready` card writes no scan row, so
    a scan-history check would break the desk.
- **Tests first:**
  - one fixture per reason: `not_found`, `ambiguous`, `test_pass`, `live_pass`, `not_accepted`, `wrong_event`,
    `removed`, `voided`, `expired`, `not_yet_valid` and `ended` (pass and event windows), `check_required`;
  - precedence: a removed and expired pass says `removed`;
  - narrowing removes ambiguity;
  - wedge CR/LF/Tab are stripped;
  - a non-ASCII barcode hashes the same as at publish;
  - the card has no `barcodes`, `barcode`, `nfc`, `authenticationToken`, `webServiceURL`, `serialNumber` or email;
  - tenant isolation: org B's code, barcode, lookup number, pass id and asset through an org A scanner give bodies
    equal to a random code's (snapshot, `scanId` and `at` masked);
  - a grant minted for scanner A is refused for scanner B and after 1 h; a desk card's photo loads with no scan row;
  - a live scanner reading a test pass gets no holder title and `display: null`;
  - the card's `display.identity.holder` is set; a desk-only input bound in the meta line is absent for a Door scanner;
  - a resolve with a history doc keeps the round-trip count (history rides in the batch);
  - an unassigned scanner's session says `unassigned` and its reads are refused `not_accepted`;
  - D1 round trips per SA §13.1 (`count-d1.ts`);
  - admin scope: the org must be in scope, and the mode comes from the header.
- **Done when:** all of the above pass, and p95 ≤ 120 ms in a local loop of 200 resolves (logged, not asserted).

**SV.2 Check-in, gates and counts** (M1; needs SV.1)
- **Files:** `act.ts`, `repo-scans.ts`, `repo-gates.ts`, `counts.ts`, `repo-counts.ts`, `routes.ts` (`POST /actions`,
  `GET /scans`, `GET /summary`).
- **Build:**
  - the act algorithm of SA §8.4: claim `INSERT … ON CONFLICT DO NOTHING`, the replay rules of SA §7.2, resolve,
    policy, gate, effect and finalize;
  - the gate UPSERT of SA §7.3 for `once`, `daily` and `always`, with scope `event:<id>` or `day:<date>` in the venue
    time zone, and `in`/`out` for re-entry;
  - the **check-in fast path**, one batch: gate, then finalize under `WHERE EXISTS`, then a ledger insert under the
    same `EXISTS`;
  - `letInAgain` overrides through `overrideOf`, validated per SA §2.6 (same org, mode, pass, action and
    `actor_key`; a `heads_up` row with an overridable reason; ≤ 10 min; not overridden yet; else 422
    `SCAN_OVERRIDE_INVALID`); capacity (`capacity_full`, a soft limit);
  - counts: `today` and event `{ arrived, inside, expected, capacity }`, with `expected` cached in the row for 60 s;
  - server-decided milestones `count` (each multiple of 100 crossed by this increment) and `all_in`;
  - ledger kinds per SA §8.5; `writeEvent('scan.result')`; both never throw;
  - `display` on every outcome for its screen (`ok`, `heads_up`, `refused`) with post-effect values, built by C17 with
    its history statements in the counts batch; `null` for unknown passes and mode mismatches.
- **Tests first:**
  - same key twice gives the same `scanId`, `replay: true`, one ledger row;
  - same key with another body gives 422 `IDEMPOTENCY_KEY_REUSED`;
  - pending < 15 s gives 409 `SCAN_IN_PROGRESS` with `Retry-After: 1`;
  - 10 concurrent check-ins of one ticket from 10 scanners (`Promise.all` on `SELF.fetch`) give one `ok` and nine
    `already_done`, each naming the winner's scanner and time;
  - `daily` resets at venue midnight (fake clock, two time zones);
  - `letInAgain` anyone, manager and never;
  - `overrideOf` naming another scanner's scan, another pass, an `ok` row or an 11-minute-old heads-up gives 422;
  - capacity full, then override;
  - check-in creates no `pass_versions` row and no `pass.updated`;
  - a milestone fires exactly once under concurrency;
  - round-trip count for a door check-in ≤ 5, with a header-only display and with a history display;
  - a refused body for an unknown code is byte-equal across orgs, `display: null` included;
  - an injected `buildDisplay` failure still returns the verdict (C17 never throws);
  - an injected crash after the gate is finalized once by reconcile (SV.3).
- **Done when:** the M1 door flow works through the API.

**SV.3 Cron hooks** (M1; needs SV.2)
- **Files:** `jobs.ts`.
- **Build** (SA §6.3):
  - `scan.reconcile`: 100 rows;
  - `scan.backfill`: 200 passes, through `passes/repo-write.ts` `backfillScanKeys` (PT.1);
  - `scan.retention`: `deleteInBatches` inside `CRON_QUERY_BUDGET`.
- **Tests first:**
  - reconcile finalizes a won check-in as `ok` with one ledger row, and a lost one as `failed`;
  - backfill mints scan codes in the app's base32 format and stops (`scan.backfillDone`);
  - retention deletes live scans older than `retention.scansDays`, and test scans older than `sandbox.purgeDays`;
  - every hook stays inside the budget (`jobs/query-counter.ts`).
- **Done when:** the hooks run in a worker test with bounds respected.

**SV.4 Lookup** (M1; needs SV.1)
- **Files:** `lookup.ts`, `routes.ts` (`POST /lookup`).
- **Build:**
  - search per SA §2.9 rule 3: 3+ letters as a NOCASE prefix over title or subtitle via `id IN (… UNION …)`, or an
    exact normalized email; ≤ 10 rows plus `more`;
  - `maskEmail`;
  - `photoUrl` only when the template's display sets `photo` and its `minRole` admits the actor;
  - caps: `RL_SCAN_LOOKUP`, `scan:lk` (hourly; a typed miss counts 2), `scan:miss` (30 per 10 min, then 429
    `SCAN_TOO_MANY_MISSES` and the audit once);
  - audit `scan.lookup` with the count only.
- **Tests first:**
  - minimum length;
  - a partial email returns nothing;
  - the 10-row cap with `more`;
  - masking;
  - other org and no match give identical bodies;
  - the hourly cap and doubled misses;
  - the audit has no query text;
  - `query-plans` covers both searches.
- **Done when:** guest-list lookup works through the API.

**SV.5 Value actions, staff session and approval** (M2; needs PT.1 (C5), PT.2, P0.4)
- **Files:** `effects.ts`, `act.ts` (value branch), `staff-session.ts`, `rules.ts` (value rows),
  `routes.ts` (`POST/DELETE /staff`).
- **Build:**
  - pure effects per kind (SA §7.4), re-run on each CAS attempt: `add` capped at the schema maximum; `take` gives
    `no_balance` if short; `set` validated by the input schema; `use_up` voids;
  - publish with `source: 'scan'`, `cause: 'api'` for a scanner or `'admin'` for an admin session,
    `notify: action.notify ? undefined : false`, and the `commit` hook writing the scan row and gate;
  - `expectedVersion` gives heads-up `stale` with a fresh card;
  - the two exits the hook never sees (SA §7.4): `changed: false` finalizes `ok` in its own batch with the current
    `pass_version`; `ScanEffectStop('no_balance')` thrown from `mutate` releases the gate and finalizes refused;
  - `managed_elsewhere` unless `allowOnConnected`, which sets `fieldSources[input] = 'manual'`;
  - the `dailyAmount` cap (`scan:amt`) gives `limit_reached`;
  - `needs_approval` writes no row and no idempotency entry;
  - an `approval` PIN is verified in the request, and `approved_by` is recorded;
  - staff sign-in and switch.
- **Tests first:**
  - 20 concurrent `add +1 always` give +20, or `PASS_CONFLICT` with a value equal to the `ok` count;
  - 2 concurrent `use_up` give one void;
  - a crash after the R2 put and before the CAS gives `failed`, the gate released, and a replay that applies once;
  - a CAS loser's hooked statements change nothing;
  - a `set` to the current value and an `add` at the schema maximum finalize `ok` with no new version;
  - a `take` short of balance gives `no_balance` and leaves the gate as it was;
  - a default `add` leaves the push budget, `notify: true` counts, and the fourth in 24 h is silenced while the scan
    is still `ok`;
  - Door on a Desk action gives `needs_approval` and no row;
  - a Manager PIN applies once; a Desk PIN can't approve;
  - a connection-owned input gives `managed_elsewhere`, and with opt-in becomes manual;
  - a connection sync after a scan does not undo it.
- **Done when:** M2 desk flows work through the API.

**SV.6 Undo** (check-in and check-out in M1, needs SV.2; the value kinds in M2, needs SV.5)
- M1 is required: `16-scan-door`, AD.4 and SC.4's console undo all undo a check-in in M1. Land `undo.ts` with the
  `check_in`/`check_out` rows first (SV.6a), then add the value rows (SV.6b).
- **Files:** `undo.ts`, `routes.ts` (`POST /scans/{scanId}/undo`).
- **Build:**
  - SA §7.4's undo table: a new scan row (`action_kind 'undo'`), `scan.undone`, silent;
  - own scans within `scan.undoWindowMinutes`;
  - another scan on this scanner the same local day needs approval;
  - `UNDO_SUPERSEDED` when the gate or value moved.
  - SC's console undo calls this service with an admin actor and a 30-day limit.
- **Tests first:**
  - undo of each kind;
  - an undo racing a new scan gives `UNDO_SUPERSEDED`;
  - the window edges;
  - undo of check-out returns to `in`;
  - `use_up` undo unvoids only if not removed.
- **Done when:** the M2 exit criteria pass through the API.

**SV.7 Bundle check-in and summaries** (M3)
- **Files:** `group.ts`, `routes.ts` (`GET /summary`, if not done in SV.2).
- **Build:**
  - `group: 'bundle'` checks in every eligible member (≤ 10), one row each (`key:passId`), with a shared `group_id`
    and `group: { total, done, already, refused }`;
  - the `reward` milestone when a `take`/`add` reaches a goal.
- **Tests first:**
  - a mixed bundle (one already in, one voided) counts correctly;
  - a replay of the group key is idempotent.
- **Done when:** the bundle verdict fields are filled.

**SV.8 Offline v2** (M5)
- **Files:** `roster.ts`, `batch.ts`, `routes.ts` (`GET /roster`, `POST /batch`).
- **Build:**
  - the roster per SA §9.2: event scanners with `offline`, scan-code barcodes only, `h` = the first 128 bits of
    SHA-256 of the scan code, a cursor delta, ≤ 50,000 entries;
  - the batch runs through `act` with `offline = 1`: future `clientTs` clamps, older than 24 h gives heads-up
    `ended`, and a late duplicate is recorded as `already_done`;
  - a queued override carries `override: true` (its heads-up never reached the server) and applies only when the
    scanner's `letInAgain` is `anyone`; otherwise that item answers `needs_approval`.
- **Tests first:**
  - the roster has no names, titles or emails;
  - passes with other barcodes are excluded;
  - batch ordering;
  - per-item outcomes;
  - the conflict "first scan wins" across an offline and an online device.
- **Done when:** CC.7 syncs against it.

### 5.2 SC: scan server, console

**SC.1 Scanners and pairing** (M1; needs P0)
- **Files:** `routes-scanners.ts`, `routes-pair.ts`, `scanners.ts`, `pairing.ts`, `repo-scanners.ts`,
  `dto-console.ts`.
- **Build:** SA §2.7 and §5.2:
  - create, with a pairing for devices;
  - list (mode-filtered and org-scoped), get and patch;
  - `pairing` POST and GET poll;
  - `pair-here`;
  - terminal `token` (shown once);
  - `revoke`;
  - `mode` (Go live / Move to Test mode; a test event is detached first);
  - Duplicate (a client action using create);
  - `sample-pass` (test scanners only);
  - device-side `POST /pair/preview`, `POST /pair` and `POST /unpair` (`sameOriginOnly`, `RL_SCAN_PAIR`, the
    `scan:pairfail` counter), with the consuming `UPDATE … RETURNING` and `auditStmt('scanner.pair')` in one batch;
  - the cookie `__Host-wallet_scan; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=15552000`.
- **Tests first** (SA §14.1 Pairing):
  - unknown, expired and used codes give byte-equal `PAIRING_INVALID`;
  - preview consumes nothing;
  - two concurrent pairs give one winner;
  - a new code voids the old one;
  - re-pairing revokes the old token at completion;
  - the failure caps;
  - revoke bites on the next request;
  - Go live keeps the token;
  - the audit rows of SA §2.11;
  - the pairing code is never in a log or audit line;
  - create or patch with another org's template ids or event id gives 404; Go live bumps `configRev`, and is refused
    (422 `SCAN_MODE_MISMATCH`) while the scanner is on an event of the old mode, unless the event is detached in the
    same call.
- **Done when:** the console API pairs a `fake` browser end to end in a worker test.

**SC.2 Events** (M1; needs P0)
- **Files:** `routes-events.ts`, `events.ts`, `repo-events.ts`.
- **Build:**
  - create, edit, get, list, archive and assign (moves scanners);
  - validation: templates must have a `check_in`, `closes_at > opens_at`, and a match input must be a scalar input;
  - the optional staff `note` (`PlainTextSchema(140)`), returned in `ScanSession.event.note` (SV.1 reads it);
  - status: `upcoming`, `live`, `ended` or `archived`;
  - `expected` refresh.
- **Tests first:**
  - lists filter by mode and org;
  - assigning moves a scanner off its old event; assigning another org's scanner gives 404, another mode's 422
    `SCAN_MODE_MISMATCH`; templates of another org give 404;
  - archiving detaches every scanner (`event_id` NULL, session `unassigned`, `configRev` bumped);
  - `expected` honours the match rule;
  - a note over 140 characters or with a control character gives 422; clearing it stores `NULL`;
  - `query-plans`.
- **Done when:** a door scanner can be bound to an event.

**SC.3 Staff admin** (M2; needs P0.4)
- **Files:** `routes-staff.ts`, `staff-admin.ts`, `repo-staff.ts`.
- **Build:**
  - add (the PIN is generated server-side and returned once), edit, reset PIN, disable and enable;
  - the `locked` flag from the counter;
  - `today` and `lastScan`.
- **Tests first:**
  - the PIN is returned once and never again;
  - a reset invalidates the old PIN at once;
  - disabling ends a scanner's staff binding;
  - names are unique per org among active staff;
  - the audit rows.
- **Done when:** staff sign-in works with a console-made PIN.

**SC.4 Scans log, detail and console undo** (M1; feed and CSV in M3)
- **Files:** `routes-scans.ts`, `feed.ts`.
- **Build:**
  - `GET /api/v1/scans`: `ScanRecord` rows for admins; `ScanFeedRow` for `scans:read` keys (no titles, no staff
    names);
  - the filters of SA §4.3;
  - `GET /{id}`;
  - `POST /{id}/undo` (SV.6 service, ≤ 30 d, audited);
  - `GET /export` CSV: ≤ 92 d, ≤ 100k rows, the `scan:export` counter, audited.
- **Tests first:**
  - a key sees its org only and its mode;
  - the feed has no names;
  - the CSV is streamed and audited;
  - an export over the limits gives 422;
  - `query-plans` for each filter.
- **Done when:** the Scans tab data is served.

**SC.5 Live dashboard and stats** (M3)
- **Files:** `live.ts`, `routes-events.ts` (`GET /{id}/live`, `/summary`), `routes-scanners.ts` (`GET /{id}/stats`).
- **Build:** `ScanEventLiveSchema` (30 one-minute points, per-scanner rows, reasons, latest 20) from D1 only.
- **Tests first:**
  - the numbers equal the `scans` and `scan_gates` truth after a seeded run;
  - a round-trip count ≤ 4.
- **Done when:** the AD.7 dashboard renders from it.

**SC.6 Scan targets and metrics** (M3)
- **Files:** `repo-target.ts`, `modules/metrics/*` (g).
- **Build:**
  - `scanTargetWhere` (C9) for `{ eventId, checkedIn }` and `{ noScanDays }`;
  - metrics: `totals.scans`, `totals.scanRefused`, `series.scans`, `setup.scanners`, and `live` (≤ 3), with an AE
    query plus the D1 fallback.
- **Tests first:**
  - the target SQL uses `scan_gates` and the `scans_pass` index (`query-plans`);
  - metrics come from D1 in tests (no `ANALYTICS_SQL`).
- **Done when:** PT.5 and AD.7 can consume it.

**SC.7 Terminals** (M3)
- **Build:** the bearer path through the guard; terminal role from `roleWithoutSignIn`; the summary-only card.
- **Tests first:**
  - a terminal can't approve, override or search;
  - its `undo` is limited to its own scans;
  - a loop over the OpenAPI document proves a scanner credential (cookie and bearer) opens no non-scan route.
- **Done when:** `docs/api.md` "Scan from a till" can be written against it.

### 5.3 PT: passes, templates and NFC server

**PT.1 Pass engine hooks** (M1, first; needs P0)
- **Files:** `modules/passes/{publish,repo-write,builder}.ts`, `src/shared/pass-view/{validity,normalize}.ts`.
- **Build:**
  - C5 (the `commit` hook in `casPublish`);
  - C6 (extract `validityOf`; `normalize.ts` calls it);
  - C7 (`lookup_hash` written by `casPublish`, `casMeta` and `createPassRow` when the template has `scan.lookup`);
  - `backfillScanKeys(db, limit)` for `scan_code`, `barcode_hash` and `lookup_hash`.
- **Tests first:**
  - a hooked statement runs only when the CAS wins;
  - three CAS losers leave no hooked writes;
  - `validityOf` gives the same answers as the old normalize for every fixture in `normalize.test.ts`;
  - the lookup hash equals `lookupHashOf(input value)`;
  - backfill leaves removed passes' `barcode_hash` NULL.
- **Done when:** all passes tests pass, and SV can build on C5, C6 and C7.

**PT.2 Manifest validator and persistence** (M1; needs P0.2)
- **Files:** `src/passkit/template/scan.ts`, `src/passkit/template/manifest.ts` (one call each),
  `modules/templates/package/{manifest,manifest-rules}.ts` (persist `scan` with `display`, and `nfc`; take `nfc` out of
  `DATA_ROOTS`).
- **Build:** `scanIssues` and `nfcIssues` with every error, warning and info code in SA §4.1; `validateManifest` calls
  `scanDisplayIssues` (C16) after `scanIssues` (a stub until DS.1 merges); the display's own 16 KB cap
  (`SCAN_DISPLAY_TOO_BIG`) inside the 64 KB manifest; `scan` is never a `DATA_ROOT` and never reaches `pass.json`.
- **Tests first:**
  - one case per code;
  - the designer round trip keeps `scan`;
  - a template `pass.json` with `nfc` gives `NFC_IN_PASS_JSON`;
  - an upload with a `scan.display` error is refused with the `SCAN_DISPLAY_*` code and its JSON path; warnings reach
    the report; `scan.values` or `scan.identity` give `SCAN_SHAPE`;
  - `scan` edits bump the version, and the stale reissue is metadata-only (no push) when `pass.json` is equal.
- **Done when:** templates with `scan` upload and save.

**PT.3 Blueprints** (M1; needs PT.2)
- **Files:** `templates/starter-*` (existing paths keep their names), the new `templates/starter-stamp-card/`
  (start from the template-identity draft, `scratchpad/template-identity/templates/starter-stamp-card/`); the strip
  switch touches `src/passkit/template/bindings.ts` and the package loader (a2's files: say so in the report).
- **Build** (SA §11 Blueprints, DM §2.3):
  - **event ticket**: barcode `{{pass.scanCode}}` (alt text `{{ticketId}}`), `check_in`, a window from
    `startsAt`/`endsAt` (180/60 min), lookup `ticketId`;
  - **coupon**: `{{pass.scanCode}}` with `use_up`;
  - **generic**: `{{pass.scanCode}}` with `check_in` `daily` and lookup `memberId`;
  - **Balance card** (the store card): keeps `{{cardNumber}}`; the balance is the primary field; on `balance`:
    `take` **Charge** (`charge`) (staff enter the amount, up to 1,000, confirm above 100) and `add` **Top up** (`top_up`; staff enter the
    amount, up to 1,000, Desk), and `set` **Set balance** (`set_balance`; Managers only, confirm; `16-scan-desk`'s Manager PIN case);
    currency from the `currency` input, which the `balance` field's `currencyCode` binds to (as in the
    template-identity draft);
    lookup `cardNumber`. No stamps (§1.5);
  - **Stamp card** (new, so no reissue): `holder`, `cardNumber`, an integer `stamps` (0-10, default 0) and `reward`
    (default "Free item"); `add` **Add stamp** (`add_stamp`, `amount: { max: 5, default: 1 }`, the default 5-minute cooldown; the
    add stops at 10, SA §7.4) and `take` 10 **Redeem reward** (`redeem_reward`, goal 10); lookup `cardNumber`. Palettes, strip art,
    icons and gallery tiles come from the template-identity designer (`scratchpad/template-identity/`, `spec.md` once
    it lands);
  - **Stamp strip.** The pass front shows one pre-rendered strip per count, `variants/stamps-0/` to
    `variants/stamps-10/` (`strip@2x.png`, `strip@3x.png` each). Today an image binding can only drop its slot
    (`bindings.ts` `applyImage`). Build the draft's binding: `{ "to": { "image": "strip", "prop": "variant" },
    "value": "stamps-{{stamps}}" }` swaps the slot for that variant's files; a value with no matching folder keeps the
    base strip, and the package check warns when a bound input's range (0-10 here) has a value with no folder. If `spec.md` settles a different shape before this task starts, build that instead. The Stamp card
    doesn't merge without the switch: if it isn't ready, PT.3 ships the other blueprints and the Stamp card follows
    as its own PR, with the e2e Stamp card cases skipped until then;
  - **generic**: also mark `phone` `x-widget: tel` (it is out of scope by name already; DM §1.11 rule 8);
  - each blueprint's `scan.display` (DM §2.3, needs DS.2 for the preset output): event ticket, holder `{{attendee}}`
    and one Ticket panel (Seat `big`, Ticket, Doors, Room); Balance card Balance (`money` with `lowBelow: 5` and a 3-row ledger of action
    labels); Stamp card Loyalty (the stamp grid, **1 reward ready**); coupon Offer; generic Membership without photo;
    the Balance and Stamp cards use `{{inputs.holder}}` (`holder` is a reserved display root);
  - boarding pass and Henry's: unchanged (no display block: the Details default).
- **Tests first:**
  - every blueprint validates, its display included (`npm run gen` fails on a `SCAN_DISPLAY_*` error);
  - `tools/build-templates.ts` output is current;
  - the Stamp card builds at `stamps` 0, 7 and 10 with the `stamps-0`, `stamps-7` and `stamps-10` strips (their image hashes differ);
    once SV.5 merges, `effects.ts` on the shipped manifest: Add stamp of 2 at 9 gives 10, Redeem reward at 10 gives 0;
  - the Balance card at `currency: 'EUR'` renders the field and the `money` row in euros;
  - a stale reissue of seeded passes publishes without a change message.
- **Done when:** `npm run gen` output is committed.

**PT.4 Pass view for scanners** (M1; the full pass now sits behind the identity row's chevron, UI.3)
- **Files:** `src/web/pass-card/*` (an optional `barcode={false}`, SSR-safe); move `usePassView` from
  `src/web/admin/passes/pass-preview.tsx` to `src/web/pass-card/use-pass-view.ts`.
- **Tests first:**
  - a PassCard without a barcode renders no barcode node and still passes `ssr-parity`;
  - the admin preview is unchanged.
- **Done when:** UI.3 can render `PassSheet`.

**PT.5 Pass-list scan filter** (M3; needs SC.6)
- **Files:** `modules/passes/repo-list.ts` (`passFilterSql` uses `scanTargetWhere`).
- **Tests first:**
  - the list and broadcast audiences filter by checked-in, not checked in, and no scan in 30 or 90 days;
  - `query-plans`.
- **Done when:** AD.7 filters work.

**PT.6 NFC server** (M4; needs P0)
- **Files:**
  - `modules/nfc/{routes,service,repo,gate,keys}.ts`;
  - `modules/passes/builder.ts` (call `nfcDictionary`);
  - `modules/passes/create.ts` (serial rule);
  - `modules/identities/*` (audit `identity.nfc_change`, the `nfcKeys` DTO).
- **Build:**
  - SA §10: the five gates;
  - `nfc` = `{ message: scanCode, encryptionPublicKey: active key SPKI, requiresAuthentication }`;
    `requiresAuthentication` forces `sharingProhibited`;
  - key create (validates P-256 SPKI; `key_id` = the first 4 bytes, hex, of SHA-256 of the X coordinate), rotate
    (the old key becomes `retiring` and a scoped bulk reissue starts with `notify: false`), retire (`force` needs
    `passesLeft = 0` or an explicit force);
  - `POST /nfc/test` resolves a message in an org and never logs it;
  - a 60 s per-isolate cache of the active key;
  - `SERIAL_NOT_ALLOWED` on an NFC identity.
- **Tests first:**
  - each gate off omits `nfc`, and all on emits the right key per (identity, org);
  - two orgs on the platform identity get different keys;
  - removal strips `nfc`;
  - the key id test vector;
  - a bad SPKI is refused;
  - gate flips start a scoped reissue (filters identity and org);
  - no private key field anywhere in contracts, DB or logs;
  - `nfc.enabled = false` by default in every environment's settings.
- **Done when:** M4 server exit.

**PT.7 Display-only versions** (M2; needs P0.2; consumer TD.4)
- **Files:** `migrations/0018_templates_build_key.sql` (SA §6.1a), `modules/templates/{persist,repo-stale,versions}.ts`,
  `src/shared/contracts/templates.ts` (C19); tests beside each; `test/migrations.test.ts` case.
- **Build** (SA §4.6 "Versions", DM §2.5):
  - `build_key` = SHA-256 of `pass.json`, assets and the manifest without `scan.display`, `description` and
    `previewOnlyAssets`, computed in `persist.ts` on insert; old rows stay `NULL`;
  - stale means the pinned version's `build_key` differs from the active one's, or either is `NULL`
    (`countStalePasses`, `quietUnqueuedTemplates` join on `template_versions`);
  - `activate: 'display-only'` activates only when the new and active build keys match, else saves without
    activating; the response adds `displayOnly` and `activated`; `TemplateVersionSchema.displayOnly` for the list;
  - the stale job with equal build keys sets `reissued_version` and moves nothing;
  - audit `template.version_created`, and `template.version_activated` with `displayOnly: true`.
- **Tests first:**
  - a display-only save activates, writes no `pass_versions` row, no outbox row and no R2 object, and `countStalePasses`
    stays 0;
  - a save that also changes `pass.json` with `'display-only'` is saved, not activated;
  - a `NULL` build key counts as stale (today's behaviour);
  - rollback: activating an older display-only version moves no pass;
  - `query-plans` uses `template_versions_build`.
- **Done when:** TD.4's save goes live on the next scan in a worker test.

### 5.4 CC: scan client core

**CC.1 Reducer and store** (M1; needs P0.6)
- **Files:** `machine/{reduce,reduce-read,reduce-answer,reduce-env,present,ignore,deadlines,derive,store,commands,use-scan-machine}.ts`.
- **Build:**
  - AC §3.4's transition tables for the door loop, env, overlay, block (including `'staff'`) and network;
  - the B amendments of SA §7.5: no decode pause during a verdict (only D0 → T0), a different code from T0 + 350, the
    card layer (`rising` → `up` at 380 → `tucking` → removed at +180), `card.rise`/`tuck`/`swap` commands, a read
    during a result enters `checking` with the old card up (no rummage), the interrupt swap, a verdict mid-rise;
  - `present()` per AC §3.3 with SA §7.5's holds (desk `ok`: tint 1.2 s, then the card stays up), `tint`, `dim`, the
    dock mode (door row, amber pair, commit pair, keypad tray) and the promoted action (an available `take` with a
    `rewardLabel` that the input now covers becomes the dock's primary); `view.buddy` has no seat;
  - `store` runs commands over injected deps (api, camera, sound, clock, ids);
  - `useScanMachine` (C10).
- **Tests first** (AC §10.1):
  - every `read` table cell;
  - same-code windows at 5,000 ms and 5,001 ms; a different code at T0 + 349 is held as `next`, at 350 it checks;
  - card phases and the swap; a verdict mid-rise emits one `card.swap`; the promoted action appears only when the
    `take` is available;
  - `slow` at 300 ms (rummage plus a tick, once);
  - the 5 s timeout;
  - door network failure: `unsure` and the key reused inside 2 min;
  - a late answer replaces the verdict on screen and updates the recent row off screen;
  - `heads_up` never times out, and `holdResults` holds everything;
  - an override gets a new key with `overrideOf`;
  - `revoked` blocks and stops the camera;
  - the seeded 2,000-sequence property test (never two loop requests in flight, never a timed `heads_up` close,
    `ignore` and `recent` ≤ 20);
  - `present.test.ts` covers every kind × posture.
- **Done when:** UI can drive every state through `dispatch`.

**CC.2 Input pipeline** (M1)
- **Files:** `input/{bus,normalize,us-keymap,wedge-detector,wedge-source,wedge-field}.ts(x)`, `input/{nfc-bridge,nfc-source}.ts` (interface only).
- **Build:**
  - AC §2.2 and §2.4: one capture-phase `keydown` listener; characters from `event.code` with the US keymap; a burst
    is ≥ 4 chars with a mean gap ≤ 50 ms, terminated by Enter/Tab or 150 ms idle; `WEDGE_SLOW`;
  - field restore;
  - `method: 'nfc'` when `reader === 'nfc'` and the value has the scan-code shape;
  - local refusals: our-origin `/p/` and `/b/` give `add_link`; a pairing link or any other path gives `not_found`;
    never sent.
- **Tests first:** the AC §10.2 timeline table, the jsdom source cases, `badLayout` detection, and a guard test that
  every `input`/`textarea` is a registered wedge field.
- **Done when:** a wedge burst becomes `{ code, method }` on the bus.

**CC.3 API client, session and v1 offline** (M1)
- **Files:** `api/{scan-api,to-fail}.ts`, `boot/{use-scan-session,pair-link}.ts`, `offline/{db,unsure-store,hash,wipe}.ts`.
- **Build:**
  - typed calls for every device route (C1); `x-csrf-token` from the session (in memory only);
  - HTTP to `fail` mapping (SA §2.8);
  - `#pair=` read once and `history.replaceState('/scan')` before any request;
  - IndexedDB `passbook-scan.unsure`;
  - wipe on revoke, unpair, a scanner change, a mode change or an event change;
  - `configRev` on any `counts` different from the session's → refetch `GET /scan/session` between scans (never
    under an open card or drawer).
- **Tests first:**
  - the fragment is stripped before the first fetch (spy order);
  - `unsure` lifecycle and expiry, and that entries hold no holder data;
  - a 429 maps to `rate_limited` with `Retry-After`;
  - a 401 with `SCANNER_REVOKED` maps to the block.
- **Done when:** the session boots against a stub server.

**CC.4 Camera and decoder** (M1)
- **Files:** `camera/*`, `platform/{wake-lock,lifecycle,prefs,persist}.ts`, `camera/fake-camera.test-support.ts`.
- **Build:**
  - AC §2.3, §6.1-6.2, §6.6;
  - `zxing-wasm/reader` in a module Worker at ≤ 8 fps (4 when slow), a centre ROI, a wide frame every 4th, never two
    frames in flight;
  - 1D codes need two identical reads within 600 ms;
  - freeze on a hit and report the polygon for the lock box;
  - `BarcodeDetector` only if `getSupportedFormats()` covers the session formats;
  - lens pick, torch by `getCapabilities().torch`, wake lock, idle pause at 60 s;
  - the `.wasm` is served same-origin from `/assets/`.
- **Tests first:**
  - `pick-camera`, `errors`, `roi` and `stability` (pure);
  - the frame loop with a fake decoder and clock;
  - `zxing-decoder.test.ts` decodes committed PNGs (QR, PDF417, Aztec and Code 128 of a 26-char scan code, a rotated
    QR, a 2× PDF417) made with `shared/pass-view/barcode-svg.ts`.
- **Done when:** the IN.2 fake-camera spec decodes through the real worker under the `/scan` CSP.

**CC.5 e2e hook** (M1)
- **Files:** `dev/test-hook.ts`, imported under `import.meta.env.DEV` (C13).
- **Tests first:** the production build has no `__passbookScan` (the bundle check from P0.5).
- **Done when:** IN specs can inject reads.

**CC.6 Desk regions** (M2; needs CC.1)
- **Files:** `machine/reduce-card.ts` (+ `reduce-card-*.ts` splits).
- **Build:**
  - member, picker, reviewing, applying and ready-action (`armed` sticky and one-shot), all as `card.kind: 'panel'`
    with the dim on and the dock in commit mode; `amountOpen` passed to the view so only the first panel shows;
  - `held`: a read while a panel holds a draft (the "another pass scanned" strip); with no draft, an interrupt;
  - applied: the panel tucks and the `ok` card rises;
  - approval (re-send the draft under a new key with `approval`);
  - staff sign-in block;
  - `stale` reopening the picker;
  - card idle clear at 60 s (off with `holdResults`).
- **Tests first:** the AC §10.1 desk rows; approval reuses the draft but not the key; `needs_approval` sends nothing
  until the PIN.
- **Done when:** UI.6 can drive every desk state.

**CC.7 Offline v2** (M5; needs SV.8)
- **Files:** `offline/{roster,decide,queue-store,sync}.ts`.
- **Build:**
  - SA §9.2: the roster delta every 60 s, valid 24 h;
  - `decide` (pure);
  - the queue in IndexedDB;
  - sync in batches of ≤ 50, oldest first, backoff 2 s to 60 s, a row removed only on its ack;
  - the amber chip after 10 min.
- **Tests first:** AC §10.5 (`decide` rows, store lifecycles, sync with a fake clock and API, nothing deleted before
  the ack).
- **Done when:** M5 exit with IN.2's offline spec.

**CC.8 Service worker v3** (M5; needs CC.7)
- **Files:** `offline/sw-register.ts`, `src/web/scan/sw/scan-sw.ts`, the build emit (via integration: `vite.config.ts`
  and `wrangler.jsonc` `!/scan-sw.js`).
- **Build:**
  - scope `/scan`, registered only on offline scanners;
  - navigation is network-first (3 s), falling back to the cached `scan.html`;
  - `/assets/*` cache-first;
  - `/api/*` never cached.
- **Tests first:** the fetch-handler routing as unit tests with fake `Request`s; `wrangler-config.test.ts` accepts the
  build-emitted name.
- **Done when:** a cold offline start on Chromium e2e shows the Start panel.

### 5.5 UI: scan screens

Sheets and dialogs follow the admin scale (14 px body, 36 px controls on fine pointers, 44 px with 16 px field text
on touch); the capsule, card and dock follow BF (dock buttons 50, the card's type steps). Safe areas everywhere. Every
changing slot has a fixed size from the first frame. Kit imports go by file,
never through `@/web/ui/index.ts`.

UI owns the visual direction (§3). BF is the build spec for every `/scan` screen; SD §4-§7 give the frame, states and
copy. The BF sheets are the visual target; the v1 `scan-*` mockups are superseded (SD §14).

**UI.1 Shared pieces** (M1, first)
- **Files:** `src/web/ui/code-field.tsx` (moved from `portal/`, with `length` and `group`). `/scan` has its own shell,
  so `AppShell` and `ModeBand` need no new props.
- **Tests first:** existing portal and admin tests pass; the `CodeField` 10/5 grouping and Crockford normalisation.
- **Done when:** the move is merged and announced to h0 and j.

**UI.2 Shell, boot and Start** (M1; needs UI.1, CC.1 fixtures)
- **Files:** `app.tsx`, `ui/{scan-shell,capsule,chips,live-announcer,scan-menu,start-panel,verdict-tint,dock,last-scan-strip}.tsx`,
  `ui/scan.css`, `boot/{pair-view,pair-confirm,admin-scope,block-panel}.tsx`.
- **Build:** SD §2 (IA, capsule, menu), §4 (the B frame), §5.1 (boot states and copy, as cards), §5.6 (chips, the
  **Test** chip); `ScanShell` with BF's layers and z-order (camera, tint, card layer, dock, buddy seat, capsule, ring);
  BF's tokens in `scan.css` (verdict hues, theme washes, glass with the reduced-transparency fallback); the dock with
  its strip and thumb row; two persistent live regions (clear, then set 50 ms later).
- **Tests first** (web project):
  - every boot state at 390, 820 and 1180 container widths, light and dark: no axe violations, the right live-region
    text and politeness, and the focus target;
  - the **Test** chip visible on test scanners, above the tint;
  - the C14 test ids are present.
- **Done when:** pairing and Start render from fixtures.

**UI.3 Door: camera layer, result card and recent** (M1; needs UI.2, UI.6, PT.4, CC.1)
- **Files:** `ui/{camera-layer,camera-panel,reader-stage,recent-scans,shift-sheet,shift-summary}.tsx`,
  `result/{card-layer,result-card,verdict-band,verdict-glyph,identity-row,notes-slot,pass-sheet}.tsx`,
  `result/{result.css,motion.css}`.
- **Build:**
  - SD §4 and §5.2-5.3, §5.7, BF "The card", "Motion" and "iPad";
  - the camera layer: reticle, lock outline and live pill, fading while a card is up;
  - the card layer: FLIP from the violet pass's live box (`--fx --fy --sx --sy`), rise 210 + settle to 380, the skin
    lifting in 60, glyph pop, text rise, tuck 180, the interrupt swap (old at z 9 tucks in 150, new rises at z 11),
    `commitStyles()` on a verdict mid-rise; reduced motion cross-fades in 120;
  - the verdict band: row, stack and stack-custom layouts; the iPad split (360 px column); solid glyphs; the custom
    icon with the verdict badge and the eyebrow; the hold rail; milestone foil ring and sparks;
  - the identity row (pass tile or photo, holder line, meta, flags then chips, chevron to `PassSheet`) and the compact
    pass row for refusals (neutral ticket tile, never the art);
  - the notes slot: `notes.staff`, `notes.refused`, then the event note on heads-up and refused;
  - the dock's door modes: strip at T0, amber **Let in again** · **Done**, slate **Done**;
  - the result card paints `ScanOutcome.display` only (never `card.display`); the live/test row from
    `ScanOutcome.template.name`;
  - the band and identity row are fixed in the card; the body scrolls when the card would pass its top limit;
  - `PassSheet` lazy (`pass` chunk), `aria-hidden` still, no barcode;
  - **Keep results until tapped** respected.
- **Tests first:**
  - `verdict.test.ts`: every band on-colour and tint pair ≥ 4.5:1 from resolved tokens, light and dark;
  - every reason in `SCAN_COPY` renders its headline, sub, glyph and dock actions;
  - refused renders no panels, chips or meta even when `display` carries them (defence in depth);
  - a custom icon always shows the badge; a custom title always shows the eyebrow and the announcement starts with the
    system headline;
  - **Done** (dock) is focused on amber and the first dock action on slate;
  - Esc dismisses, and a click on the card doesn't;
  - no-shift test: the capsule chips, the dock strip, the card's bottom edge and the buddy seat keep their boxes;
  - card geometry per BF: top ≥ 117, bottom 560 at 390 × 844, measured heights of the BF examples within 2 px;
  - reflow at 320 px with no horizontal scroll (the card body scrolls under the band);
  - a refused outcome whose `card.display` carries panels paints none of them;
  - axe at three widths in both themes.
- **Done when:** `b-final-phone-door-*`, `b-final-ipad-door-*` and the motion strips are matched.

**UI.4 Lookup** (M1)
- **Files:** `lookup/{lookup-sheet,lookup-results}.tsx`.
- **Build:**
  - SD §5.5 and §2.2: a full-height sheet on a phone, a sheet on a tablet, a 400 px side sheet at the start on wide
    screens, opened from the dock's **Look up**;
  - the field is a registered wedge field;
  - `/` focuses, ↓ enters, Esc clears then blurs;
  - masked email shown as given;
  - `gcTime: 0`.
- **Tests first:**
  - the min-length, `@` and code-typed hints;
  - the 429 line;
  - the 10-row footer;
  - a pick closes the sheet and focuses the desk panel's heading;
  - a reader burst inside the field becomes a scan and restores the field.
- **Done when:** the lookup sheet is rendered in B (SD §14 "renders still owed") and matched.

**UI.5 Desk** (M2; needs CC.6, UI.3)
- **Files:** `desk/{desk-panel,action-area,stepper,review}.tsx`, `ui/{keypad,approval-panel}.tsx` (`Keypad` and
  `PinDots` live in `ui/` because the staff sheet and the approval panel use them outside the desk chunk),
  `boot/staff-sheet.tsx`, the dock's desk modes in `ui/dock.tsx`.
- **Build:**
  - SD §5.4, D6-D9, BF "Desk panels";
  - the desk panel over the dimmed camera (200 ms, keeps decoding): header, the template panels, the action area;
  - while an amount control is open only the first panel shows, its `progress` or `money` row previewing the draft
    (pending stamps outlined, the old balance struck) from `card.values` and the draft amount;
  - one `Keypad` (`inputmode="none"`) for amounts, staff PINs and Manager PINs; on a phone the amount keypad sits in
    the dock tray with the commit pair above it; on iPad beside the panel, with presets;
  - the commit pair in the dock (verb armed at 260); locked actions under **More** with `Lock`;
  - **Ask a manager** turns the panel into `ApprovalPanel`;
  - the promoted **Redeem reward** as the dock's primary after an `ok` that reaches a goal;
  - the `held` strip from the panel's top edge;
  - the `desk` lazy chunk loads only when `flow` is `choose`.
- **Tests first:**
  - the stepper bounds and the "Up to {max} per scan." hint;
  - plurals through `Intl.PluralRules`;
  - the review face per kind;
  - a locked commit leads to the PIN panel and re-sends the draft;
  - the wrong-PIN and locked messages;
  - the Balance panel plus the keypad tray fits 390 × 844 without scrolling, with the `history` row trimmed to its
    newest item while the tray is open (DM §1.2);
  - opening the action area moves nothing above the first panel;
  - the display never renders a button (no `button` inside `display-panel`);
  - axe.
- **Done when:** `b-final-phone-desk-*` and `b-final-ipad-desk-*` are matched, the keypad tray is rendered and
  matched, and `16-scan-desk` passes.

**UI.6 Display painter** (M1, early; needs P0.2 (C15))
- **Files:** `display/{display-panels,panel,rows-text,rows-value,rows-list,chip,icons}.tsx|ts`, `display/display.css`,
  tests beside each.
- **Build:**
  - paint a `ScanDisplay` (DM §5.5) with BF's row specs ("Rows"): heading, field, big, columns (big and normal; one
    line under 400 px only when `oneLine`, else two per line; always one line at the wide width), progress (stamps 44,
    5 a row on a phone; the bar; new and pending stamps; the system caption), money (old struck, new, the change chip,
    **Low balance** in gold), history (rows ≥ 44, **Changed elsewhere**), image (thumbnail, strip), chips, list (pair),
    note, divider;
  - the panel frame (header icon, label, trailing detail; r 16, padding 12, gap 12); template tones only on stamps,
    fills, list icons and the caption gift;
  - `icons.ts`: every `SCAN_ICONS` id to its Lucide component; an unknown id paints `info`;
  - text nodes only, `dir="auto"`; no animation except the system progress fill and count-up (reduced motion: stills);
  - an unknown row type is skipped (forward compatibility); width from the container, never from measuring text.
- **Tests first:**
  - each row type and the panel frame at 390, 820 and 1180, light and dark, with max-length text: no overflow, no axe
    violations, chip and note tones ≥ 4.5:1;
  - `oneLine` honoured under 400 px and ignored at 400 and over;
  - every id in `SCAN_ICONS` maps to a component;
  - **the fit test**: per screen, the largest composition DS's budget admits after its header cost (`ok` with two
    panels at 6; `ok` with a custom title, a photo and 3 units; `heads_up` with two chip lines and 3 units) and the six
    owner examples fit the card at 390 × 844 without scrolling; it reads the constants from `density.ts`, and if it
    fails, DS lowers them, not the type size (DM §1.6);
  - the `/scan` chunks contain no `renderScanDisplay` (bundle check).
- **Done when:** `b-final-phone-custom-*` and `b-final-ipad-custom-*` are matched from DM §8's docs rendered by DS, and
  TD can import the components for its canvas (C18).

### 5.6 BU: buddy, sound and art

**BU.1 Beat API and shared art** (M1, first)
- **Files:** `src/web/ui/art/{buddy,buddy-art,replay}.ts(x)` (BM §2.1: `beat`, `pose`, `dir`, `landed`,
  `immediate`), `src/web/ui/art/art.test.tsx`, `src/web/lib/gaze.ts` (from `portal/login-scene.tsx`
  `lookAt` and `portal/login-email-face.tsx` `caretX`), the entity art `scanner`, `stub` and `badge` in the lazy
  registry (SD §10.1); the B additions (C11): an `xl-scan` size tier (192 × 144, 3 px line; 256 × 192, 3.25 px on
  iPad) and `card?: 'in' | 'out'` (hides `[data-part=c2]`, shows the 2 px pocket notch).
- **Tests first:**
  - `card="out"` hides the middle pass and leaves the outer passes; `xl-scan` keeps ≤ 40 nodes;
  - `immediate` starts in a layout effect on mount and on `replay` change, with no IntersectionObserver;
  - no `data-replay` with `immediate`;
  - sign-in gaze tests are unchanged;
  - the kit budget (expect the one ≤ 0.25 kB raise, with a comment, at the measured size; SA §13.2);
  - the lazy scenes (raise by the measured amount, ≤ 2 kB, with a comment);
  - entity art ≤ 40 nodes.
- **Done when:** existing art tests pass, and C11's `Buddy` props are merged.

**BU.2 Sound** (M1)
- **Files:** `sound/{tones,player}.ts`, `sound/audio-unlock.ts`.
- **Build:**
  - BM §12 from `buddy-draft/sound.ts`;
  - `unlock()` inside the tap;
  - `audioSession.type = 'playback'` when present;
  - suspend when hidden;
  - `passbook-scan-sound` in try/catch (a throw means on);
  - garnishes offset by output latency.
- **Tests first:** BM §14.2 `sound.test.ts` with a fake `AudioContext`; source ≤ 1.75 kB.
- **Done when:** C12 is merged.

**BU.3 ScanBuddy, poses, beats and props** (M1; needs BU.1, CC.1)
- **Files:** `buddy/{scan-buddy,beat-map,props}.tsx|ts`, `buddy/beats.css` (+ `cover.css` if needed).
- **Build:**
  - BM §2.2-§10, starting from `buddy-draft/`, with BF's changes: one seat on the dock (XL), seated on the dock's top
    edge; the violet pass is hidden while a card is up (`card` from `view.buddy`) and the outer passes fan to ±24° and
    carry the beats (`fan`, `punch` and `stamp` move off the violet pass); the ghost slot from 320 ms;
  - `coins` (BM §6.1): a money input's change on the Balance card (Charge, Top up, Set balance) drops three coins into
    the pocket, `dir="out"` when the balance falls; `sparkle` stays for points;
  - `useRegisterBuddy`;
  - `aria-hidden` and `pointer-events: none`;
  - the cut per BM §7;
  - `--lx`/`--ly` through CSSOM;
  - `sound.cut()` before every beat;
  - mood swaps at T0.
- **Tests first:** all of BM §14.2:
  - `beats.test.ts`: ≤ 700 ms except `cover` and `rings`; `infinite` only under rummage; transform and opacity only;
    reduced motion; ends at rest; the reused keyframe names still exist; sizes; the snap bound for a cut at T0 + 350
    (36 % of a beat; a beat that would jump past BM §7.5's bound eases to rest in 120 ms instead; `shake` is inside
    the bound at every frame, so it never eases, BU.5);
  - `scan-buddy.test.tsx`: one buddy on the dock across every state and overlay combination; `card` follows the card
    layer's phase; the `data-run` reset in the
    layout effect; never under reduced motion; a click reaches the dismiss handler; ≤ 40 nodes; no `<text>`;
  - `beat-map.test.ts`: every reason has a beat, mood and chirp; green-offline is neutral.
- **Done when:** 20 injected reads at a 350 ms cadence in a web test leave ≤ 1 buddy, one card, no stacked props, and
  `cut()` called 20 times.

**BU.4 Milestones and the shift scene** (M3; needs SV.2 `milestone`)
- **Build:**
  - `fan` on the outer passes, the `reward` chirp; UI.3 draws the card's foil ring and the six sparks from the glyph,
    keyed by `scanId`;
  - the shift summary `count` scene (happy with ≥ 1 ok, flat and still with none);
  - the client-side 100th-of-the-day milestone.
- **Tests first:**
  - a milestone never extends the hold;
  - a different code at T0 + 350 replaces it (the card swaps; sparks are cut);
  - reduced motion shows the still with no sparks, and the chirp still plays.
- **Done when:** BF's milestone tile (`b-final-phone-door-*` 07) is matched.

**BU.5 Head shake for red, sorry for slate** (M1; with BU.3, needs CC.1's reason → colour)
- **Files:** `buddy/beats.css` (the `shake` and `sorry` blocks), `buddy/beat-map.ts`, `buddy/props.tsx`.
- **Build:**
  - BM §6.3: `shake` for every red reason, from `buddy-draft/beats.css` (`wl-b-shake`, `-look`, `-eyes`, `-brow`,
    `-body`, `-fan`). The trunk turns −6°, +5.5°, −3.5°, +1.5° at T0 + 240, 330, 420, 500 on its feet; the face
    leads; eyes squeezed (`scale(1.12, 0.28)`) and brows pinched (0.8) from 180 to 550; the fan swings 45 ms behind
    (+4.5°, −6°, +6°, −4°, +2°, −0.8°); still by 700. Reference: BF `motion/shake.css`, the strip
    `sheets/b-final-strip-refused-*` and `video/b-final-refused-*`;
  - `beat-map.ts` derives red → `shake` from the colour (no per-reason red rows), keeps `state: 'expired'` for
    expired and the `LockArt` prop for `forbidden` and `org_inactive`; slate reasons set `pose: 'sorry'`;
  - BM §6.4: `sorry` on `cloud`, `plug`, `wait` (a bow at 350-560, then eyes up at you, passes drawn in ±14°);
    `plug`'s eyes widen instead of squeezing; the cloud moves to `aside`, on the surface at the left;
  - delete `peek`, `tear`, `sign`, `empty` and the lens and flask props (already gone from the draft);
  - reduced motion: the still "no" (trunk −4°, look −1.8, eyes shut, fan 4°) for every red reason; the `sorry` pose
    for slate.
- **Tests first** (BM §14.2):
  - beat timing (`beats.test.ts`): `shake` starts at `--wl-beat-at`, runs 550 ms, trunk and look at rest by 76 %, all
    tracks by 100 %; trunk peaks alternate and shrink; each fan peak trails its trunk peak by ≥ 45 ms; eyes squeezed
    5.5-72.7 % and in no other beat; no slate beat or pose rotates the trunk back and forth;
  - the cut (`scan-buddy.test.tsx`): a green verdict at T0 + 350 removes and resets `data-run` in one layout effect,
    and the next frame reads `rotate: 0deg` on the trunk with no `wl-b-shake` left running; red after red restarts at
    `currentTime` 0; every keyframe value of `shake` is within 6° and 3 units, so no 120 ms ease-out is needed;
  - reduced motion: every red reason renders the still "no" (computed `rotate`, `translate`, `scale`) with no
    `data-run` and no running animation; slate renders `sorry`; amber is unchanged;
  - `beat-map.test.ts`: every red reason → `shake`; no amber or slate reason → `shake`; every slate reason → `sorry`.
- **Budget:** `beats.css` source gzip 4,445 B against ≤ 4.5 kB (55 B headroom; it was 4,164), shipped 2,558 B (+113 B
  in the lazy `/scan` chunk). `props.tsx` drops to 1,508 B. Nodes: `shake` and `sorry` add none; a red refusal is the
  bare buddy (29-30). If a later beat needs room, move `cover` to `cover.css` rather than raising the budget.
- **Done when:** 20 injected refusals at a 350 ms cadence restart the shake each time, leave ≤ 1 buddy and no stacked
  props, and the web test's frames match BF's refused strip (the trunk at −6° at 240 and +5.5° at 330, still at 700).

### 5.7 AD: admin

Admin pages follow UC (list, dialog and tabbed-detail patterns, `PageHeader`, one primary per tab). They filter by
the n6 mode, poll only while visible, and use the n6 band in Test mode.

**AD.1 Frame and lib** (M1; needs P0.5)
- **Files:** `admin/scanning/{scanning-page,queries}.tsx|ts`, `routes/admin/scanning/{index,scanners.$scannerId,events.$eventId}.tsx`,
  `lib/{nav,entities,status,actions,confirms}.ts`.
- **Build:**
  - SD §10.1: tabs via `?tab=`;
  - entities `scanner` (`ScanLine`), `event` (`CalendarCheck`) and `staff` (`IdCard`);
  - palette actions;
  - rename `ENTITY.activity` to **Entry**;
  - status pills (UA §16.1).
- **Tests first:**
  - tab routing keeps filters in the URL;
  - the nav item is `orgScoped`;
  - typed `to` links;
  - the admin links to `/scan` are plain `<a>`.
- **Done when:** the empty tabs render with their empty states.

**AD.2 Scanners tab, pairing face and detail** (M1; needs SC.1)
- **Files:** `admin/scanning/scanners/*`, `admin/scanning/pairing-face.tsx`.
- **Build:**
  - SD §10.2 and mockup `admin-scanners`;
  - the New scanner dialog;
  - the pairing face: the QR on the buddy's `Scan` sign, the code `K7QH2-M9XTR` with Copy, a countdown outside the
    live region, a poll every 2 s, `wave` once on paired, `droop` on expiry;
  - Pair this browser;
  - the pairing face's `{host}` text and the **Using the Home Screen app? Pair inside it.** line (SD §10.2);
  - the till token in `SecretReveal`. **How it scans: Till** stays hidden until SC.7 merges (M3), so no token is
    issued before the bearer path is finished;
  - revoke, Pair again and Go live confirms;
  - the detail page in `TwoPane`.
- **Tests first:**
  - the poll stops when hidden or paired;
  - `wave` runs once when `pairedAt` appears;
  - the token shows once;
  - the confirm copy;
  - axe.
- **Done when:** `16-scan-pair` passes.

**AD.3 Events tab** (M1; needs SC.2)
- **Files:** `admin/scanning/events/*`.
- **Build:** SD §10.4: list, New event dialog with **Note for staff** (≤ 140), and the event page with static counts,
  Readiness, the staff note and **Result screen: {template} · Edit** (a plain link to the designer with `?mode=scan`;
  live in AD.7).
- **Tests first:**
  - time-zone display `(PT)` when it differs;
  - the note's counter and 140 limit; an empty note sends `null`;
  - templates without a check-in are disabled;
  - match-rule validation messages.
- **Done when:** an event can be created and scanners assigned.

**AD.4 Scans tab** (M1; needs SC.4)
- **Files:** `admin/scanning/scans/*`, `admin/scanning/undo-confirm.ts`.
- **Build:** SD §10.7: filters in the URL, columns, a row sheet with KeyValues, undo confirms per kind, Export CSV
  (M3).
- **Tests first:** filters round-trip through the URL; the undo copy per kind; "Unknown code" rows.
- **Done when:** the M1 console flow is complete.

**AD.5 Staff tab** (M2; needs SC.3)
- **Files:** `admin/scanning/staff/*`.
- **Build:** SD §10.3: list, Add staff with role `OptionTile`s, the PIN in `SecretReveal`, Reset and Disable confirms,
  and the "don't ask for a PIN" callout.
- **Tests first:**
  - the PIN is shown once and gone after **I saved the PIN**;
  - the locked pill;
  - axe.
- **Done when:** staff can be added and their PINs used on `/scan`.

**AD.6** moved to **TD.1** (the designer is one stream's files; §1.5).

**AD.7 Door depth across the console** (M3; needs SC.4-6, PT.5, BU.4)
- **Files:** `admin/scanning/events/live-*.tsx`, `admin/overview/*`, `admin/passes/detail/{sync-tab,sync-model}.ts(x)`,
  the passes list filters, `admin/messages/{audience,composer-state}.tsx`, `admin/audit/labels.ts`.
- **Build:**
  - the live dashboard (SD §10.4): polls every 5 s, **Pause updates**, hero with `CountUp` and a `scaleX` bar,
    per minute, by scanner, reasons and latest;
  - buddy `count` on open, `wave` at the first live check-in, `cheer` when all in, each once per event per browser;
  - overview **Live now**, **Scans** and **Refused** tiles, the KPI face milestone (BM §11.3);
  - the Sync log **Scans** filter and kinds;
  - passes list filters and a Checked-in column;
  - the broadcast audience **Scans** select;
  - audit actor **Scanner: {name}** and its filter;
  - the pass header meta.
- **Tests first:**
  - the dashboard celebrates only on a live 0 → ≥ 1 change, never on first load;
  - the KPI tile never celebrates on the first visit;
  - **Pause updates** stops polling;
  - the throttled hero announcement (30 s);
  - axe.
- **Done when:** `16-scan-admin` passes.

**AD.8 NFC console** (M4; needs PT.6)
- **Files:** `admin/identities/{nfc-card,reader-key-dialog,reader-test-dialog}.tsx`, the switch removed from
  `identity-cards.tsx`, the settings Scanning group. (The designer NFC section is TD.5.)
- **Build:**
  - SD §10.6: the checklist card;
  - reader keys per (identity, org);
  - **Make reader key** with `crypto.subtle.generateKey` (ECDH P-256, extractable), posting only the SPKI and
    offering the private key as downloads only (`passbook-reader-<keyId>.pem`; VTAP `config.txt` + `private1.pem`,
    format [U] until the first device);
  - **I saved the key file** gates **Done**;
  - rotate and retire with a typed confirm;
  - Test a reader, using `wedge-detector.ts`;
  - Settings › Scanning **NFC for passes** (off).
- **Tests first:**
  - the generated key's SPKI parses and no private key is ever sent (fetch spy);
  - a test-reader burst calls `/nfc/test`;
  - axe.
- **Done when:** M4 exit.

### 5.8 IN: integration

**IN.1 e2e harness** (M1; needs P0.5)
- **Files:** `playwright.config.ts` (a `scan-camera` project with `--use-fake-ui-for-media-stream`,
  `--use-fake-device-for-media-stream`, `--use-file-for-fake-video-capture=e2e/fixtures/scan-qr.y4m` and the `camera`
  permission), `e2e/fixtures/make-y4m.ts` (no ffmpeg), `e2e/helpers/scan.ts` (create a scanner via the API, pair
  through `#pair=`, `inject(code)` through C13, read the ledger, `saveDisplay(templateId, doc)` through the versions API
  with `activate: 'display-only'`), and `e2e/helpers/scan-templates.ts`: `makeTemplate(example)` runs **Use blueprint** on the
  example's blueprint, adds its inputs, fields and actions when it has any, saves and activates (a pass change, so a
  normal version), then issues passes with the example's sample inputs, or with per-pass overrides (`issue(template, { stamps: 10 })`). Coffee and prepaid are the Stamp card and
  Balance card as shipped (no additions); VIP, door 01 and gym add inputs no blueprint has.
- **Done when:** a smoke spec loads `/scan` and asserts its headers.

**IN.2 Specs** (§9), added as each milestone's streams merge.

**IN.3 Docs** (M3-M4)
- `docs/api.md`: **Scan from a till** (terminal token, `resolve`/`actions`, keys, outcomes, reasons and the
  `display` field), **Read scans** (`scans:read`), limits; **Result screens in templates** (`scan.display` in an
  uploaded package: the row types, bindings, limits and `SCAN_DISPLAY_*` codes, pointing to DM).
- `docs/operations.md`: the NFC runbook (SA §10.5), and turning a scanner off.
- `docs/security.md`: scanner tokens, pairing, PINs, miss caps, NFC keys, the serial rule.
- `docs/design/motion-and-expression.md`: a "Scanner beats" section pointing at BM, `cover` in the scenes table, the
  admin moments.

**IN.4 Merge guards**
- At every merge, until `0014` is on `next/integration`: no other branch adds an `audit_log` column.
- The `AGENTS.md` rows match §3.
- Both bundle budgets are reported in the merge note.

**IN.5 Release checks** (§10).

### 5.9 DS: display

DM is the spec (sections 1-7); SA §4.6 is the summary. Everything in `src/passkit/template/scan-display/` is pure:
no React, no worker imports, no sizes or colours (the §3 lint test).

**DS.1 Model core** (M1; needs P0.2)
- **Files:** `scan-display/{index,validate,validate-rules,scope,condition,format,render,render-rows,density,needs,migrate}.ts`
  (split further to stay under 300 lines), tests beside each.
- **Build:**
  - `scanDisplayIssues` in DM §6.2's order (size, `safeParse`, semantic rules, warnings) with every code of DM §6.3 and
    its JSON path; the placement rules and the density budget of DM §1.6 (≤ 5 row units per panel; ≤ 6 per result
    with 1 per frame, minus the per-screen header cost; a 4-item `columns` costs 3 worst case and 2 when `oneLine`;
    stamps cost 3 and need goal ≤ 10; an error on `ok`, `SCAN_DISPLAY_CUT` on `heads_up` and `ready`); the constants in
    one exported table in `density.ts`; the new codes `SCAN_DISPLAY_HOLDER`, `SCAN_DISPLAY_TITLE`,
    `SCAN_DISPLAY_ROLE_CONDITION`; the band title rule of DM R16 (literal plus the holder's name only, the verdict-word
    check on the literal part, the 2-line cost at save for any name token, `SCAN_DISPLAY_TITLE` for a name token on a
    `pass.title`, pass-title-fallback or `enum` holder source);
  - the scope types and `scopeCatalog(manifest, role)` (DM §3.1), reserved roots, `x-scan`, secrets out for every role
    (DM §1.11 rule 8: formats, widgets, name segments, and fields that reference them or `pass.*`);
  - `Cond` evaluation (DM §3.2): paths, numeric and `daysFromNow` comparisons in the actor's time zone;
  - the display filters (DM §1.9) and strict missing values, plurals with `Intl.PluralRules`;
  - `renderScanDisplay` (DM §5.1): role filter on the doc, identity (holder always set, photo flag), refused stop,
    variants, header per screen (the name check of DM §1.3 after sanitizing: 1-3 words matching
    `^[\p{L}\p{M}]+([ '’.-][\p{L}\p{M}]+)*\.?$`, no word of DM §1.11 rule 6's list (one exported
    `VERDICT_WORDS` in `validate-rules.ts`, shared with the save check), case- and accent-insensitive, else the token
    is empty; then the name truncated first, `titleLines`), panels (`on`, `actions`, `when`, empty drop, the 2 cut, the 1 cut with
    `amountOpen`), `oneLine` per DM §1.6's table, the render-time unit cut, sanitize and grapheme caps (DM §1.11
    rule 9); `render.ts` keeps the literal `scan-display:render` in its own error so the bundle check can find it;
  - `compileNeeds(doc)` (DM §5.3), `migrateScanDisplay` (identity for `v: 1`).
- **Tests first** (DM §7.3 unit): one case per validation code; per row type values, caps, emoji and combining-mark
  truncation, `whenEmpty: 'dash'`, plurals, every filter in two time zones across a DST change, `day` and `ago` edges;
  the safety rules (no custom icon or title on `heads_up`/`refused`, nothing but `notes.refused` on `refused`, holder
  never empty for a known pass, no output containing `{{`, secrets absent for every role); the band name cases of DM
  §7.3 ("Refunded", "not valid", "VOID 2", a 4-word name, a URL and a bidi-override name give the system headline;
  "Maya", "José", "O'Neil", "Anne-Marie" and "李小龙" render); a 1,000-name property test: no rendered title holds a
  verdict word or a digit; roles; variants; panel cuts;
  `oneLine` at every cap boundary; the lint test; a 1,000-doc property test (`ScanDisplaySchema.parse` passes, density
  holds, render under 5 ms).
- **Done when:** TD and PT can call C16 for real (the P0.2 stubs are gone).

**DS.2 Presets, defaults and samples** (M1; needs DS.1)
- **Files:** `scan-display/{presets,presets-*,defaults,sample,examples}.ts`, `scan-display/__snapshots__/`,
  `scan-display/baked.test.ts`.
- **Build:**
  - `PRESETS` (DM §1.7, §6.4): Membership, Loyalty, Balance, Ticket (Section · Row · Seat, plus Gate when a gate input
    exists; a single `seat` value writes a `big` row), Offer, Access, Details, Note; slot hints drive auto-mapping;
    rows carry `slot` tags; panels carry `preset: { id, v }`; no preset writes a control, a refusal panel or a photo row;
  - `defaultScanDisplay(manifest, passJson)` (DM §2.2): holder source, panel 1 from the actions, Details from the
    first front fields (as many as the 6-unit budget leaves, at most 4), never the holder name or an out-of-scope
    field;
  - `sampleScope(manifest, overrides)` and `sampleHistory()` (DM §6.6) for the editor;
  - `examples.ts`: DM §8's six docs and the voided case, each as `{ base: blueprint id, inputs (JSON Schema properties
    to add), fields (pass.json fields to add), actions, sample, display }`, used by UI.6's sheets match, TD.2's op
    test and IN.1's fixture templates. VIP and door 01: the event blueprint plus `section`, `row`, `gate`, `tier`,
    `table`, `dietary`. Coffee: the Stamp card as shipped, sample reward "Free coffee". Gym: the generic blueprint plus
    `plan` and a thumbnail. Prepaid (the Balance card) and coupon: the blueprints as shipped.
- **Tests first:** every preset's output validates against every blueprint manifest; the Ticket preset writes a 4-item
  `columns` row with a gate input; `defaultScanDisplay` snapshots for every blueprint and Henry's; after PT.3 merges,
  each blueprint's shipped display renders a snapshot per screen.
- **Done when:** PT.3 can write the blueprint displays from the presets and UI.6 has its fixtures.

**DS.3 Server display** (M1; needs DS.1, SV.1's stub call)
- **Files:** `src/worker/modules/scan/display.ts` (+ `display-scope.ts` if needed).
- **Build:** C17 `buildDisplay`: the screen from the outcome (system screens and unknown passes return `null`); the
  doc from the template's **active** version (the candidate query already joins `templates`), through
  `compiledDisplay` (isolate LRU, 64 entries, keyed by template and version; parse, validate, compile `needs`); the
  scope per role (inputs after `applyDefaults`, `x-scan` filtered, secrets removed; `fields` formatted as Wallet shows
  them, through the shared pass-view formatters, only when `needs.fields`; `pass`, `scan`, `event`, `scanner`, `now`
  from `ctx.clock`); terminals get no panels; the actor's time zone and the scanner's locale (`Accept-Language`, else
  `en`); any throw → `defaultScanDisplay`'s render plus one `SCAN_DISPLAY_RENDER` error log with ids only; an invalid
  stored version → `SCAN_DISPLAY_INVALID`.
- **Tests first:** each screen through `resolve` and `actions` (with SV); a desk-only input bound in a title renders the
  system title for Door; a pass pinned to an older version renders the active display; an injected throw still
  returns the verdict, the default display and exactly one log; no log or audit line contains a rendered fixture
  string; the cache never returns another version's doc.
- **Done when:** SV.1 and SV.2 call it for real.

**DS.4 History** (M1; needs DS.3)
- **Files:** `src/worker/modules/scan/repo-history.ts`.
- **Build:** C17 `historyStatements` (DM §1.10): last visit, visit counts by period in the actor's time zone (one
  conditional-sum statement, capped 9,999), the value ledger (the last N `ok` `add`/`take`/`set` scans on the input,
  over the last 50 rows, labelled by the action), the ledger month sums, last scan; `where` from `scanners.name`,
  **Console** or **Removed scanner**; undone scans and undo rows excluded; retention bound; **Changed elsewhere** when
  the current value differs from the newest listed `after`. Statements only for what `needs` lists, returned for SV's
  existing batch.
- **Tests first:** transactions exclude undone scans; **Changed elsewhere** after an admin edit; visits per month across
  a time-zone boundary; retention; removed scanner and admin session names; `query-plans` uses `scans_pass_ok`;
  round-trip counts unchanged (`count-d1.ts`).
- **Done when:** the Membership and Balance presets render real history in a worker test.

**DS.5 Real-pass preview** (M3; needs DS.3)
- **Files:** `src/worker/modules/scan/routes-display.ts`.
- **Build:** `GET /api/v1/scan-display/preview?templateId&passId&role` (SA §5.2): `requireAdmin`, org and mode
  asserted, the pass must use the template; returns the role-filtered **scope** (never a rendered display), `no-store`;
  audit `scan_display.preview` with ids only.
- **Tests first:** another org's pass gives 404 with an unknown id's body; secrets are absent for every role; the
  response has no `{{` and no email; the audit row has no values.
- **Done when:** TD.6 previews a real pass.

### 5.10 TD: template designer (Scanning, Scan screen, NFC)

TD owns `designer/scan/**` and is the only stream that touches n5's designer files and i's template pages (§3). DM
§10 is the spec; SD §10.5 and §10.8 give the copy; `docs/design/scanner/display/` are the visual target (the three model
corrections of SD §14 win over the sheets).

**TD.1 Designer Scanning section** (M2; needs PT.2) — was AD.6
- **Files:** `templates/designer/{section-scan.tsx,ops-scan.ts}` and the outline registration.
- **Build:** SD §10.5 and mockup `admin-designer`: the barcode banner with **Use scan code**; the action list (1-6,
  reorder, **First**) and the inspector; the "On the scanner" strip (inert); **Look up by**, **Window**, **Flags**; a
  **Result screen** row linking to the Scan screen mode (the old Values and Identity are gone); issue copy for SA §4.1
  codes; defaults from `scanOf`. Ops are named `scan-action-*`.
- **Tests first** (`designer.test.ts` style, pure ops): add, edit and reorder an action; **Use scan code** sets the
  barcode message; every issue code has its line; `designer-ui.test.tsx` renders the section and passes axe.
- **Done when:** a template's actions round-trip through save.

**TD.2 Scan screen model and ops** (M2; needs DS.1, DS.2)
- **Files:** `designer/{model,apply,reducer,targets}.ts` (each change under 20 lines), `designer/scan/{scan-model,ops-display,ops-display-items}.ts`.
- **Build:** DM §10.2-10.3 with the §1.5 rename: `Section` gains `scan-header | scan-rules | scan-panel | scan-notes`;
  `Op` gains `DisplayOp` (`display-init`, `display-holder`, `display-header`, `display-chip-*`, `display-variant-*`,
  `display-panel-*`, `display-row-*`, `display-item-*`, `display-when`, `display-role`, `display-photo`,
  `display-notes`, `display-remove`, `display-move`, `display-nudge`), applied by `applyDisplayOp`; one undo step each;
  typing coalesces under `merge: display:<id>:<field>`; ids from `uniqueId(doc, prefix)`, deterministic; `mode` and
  `preview` as editor state outside the history; `targets.ts` maps `scan.display.*` issue paths to selections;
  `slotPolicy(screen)` mirrors SD §5.8.
- **Tests first** (DM §10.6 unit): each op pure and replayable with the same ids; `display-panel-add` for every preset
  against every blueprint validates; `display-panel-reset` keeps untagged rows in one undo step; `display-move` refuses
  placement-rule breaks; `display-remove` cleans references; coalesced typing is one step; `slotPolicy` for all four
  screens; every row type's units match `density`; every `SCAN_DISPLAY_*` code with a path maps to a selection.
- **Done when:** the ops build DM §8's six docs from an empty doc in a unit test.

**TD.3 Outline and inspectors** (M2; needs TD.2)
- **Files:** `designer/{outline,section-inputs}.tsx`; `designer/scan/{scan-outline,section-header,section-rules,section-panel,section-notes,row-editor,row-editors-text,row-editors-value,row-editors-list,expr-field,binding-picker,icon-picker,cond-builder,preset-palette,row-palette}.tsx`.
- **Build:** SD §10.8: Header (holder source, **Show member photo** with Who sees it, `ok` icon and title, meta,
  chips; the title's picker offers only the holder's name, and only when the holder source can hold one, DM E12), Rules, a disclosure per panel with its rows (grip, Alt+Arrow, move buttons), **Add panel** (eight presets
  with schematics and **{N} found**, **Empty panel**), **Add row** with budget-aware disabling and no button type,
  Notes; tokens for bindings (Backspace removes, Enter opens Format); the binding picker over `scopeCatalog` with
  sample values and secrets disabled as **Never shown on scanners**; the 40-icon picker in 7 groups; the condition
  builder (depth 2 in the UI, deeper as "Custom condition"); the Inputs section's **Scanner** control (`x-scan`).
- **Tests first** (DM §10.6 web): the binding picker lists sample values, disables secrets and inserts a token; the
  icon picker offers exactly `SCAN_ICONS`; the condition builder round-trips DM §3.2 conditions; the holder line is
  locked and Header edits only its source; the title's picker lists only **First name** and **Full name**, both disabled with **The holder line's source isn't a name.** when the holder source is the pass title or an `enum` input; no palette entry produces a button; the Ticket preset on a template with a
  gate input writes a 4-item `columns` row; axe.
- **Done when:** every element of DM §8's docs is editable from the outline.

**TD.4 Stage, canvas and save** (M2; needs TD.3, UI.6 (C18), PT.7 (C19))
- **Files:** `designer/{designer,designer-page,api}.ts(x)`, `designer/scan/{scan-mode,scan-stage,canvas,canvas-overlay,sample,fit-card,version-card}.tsx|ts`, `designer/scan/scan.css`, `admin/templates/{template-overview,versions-panel}.tsx`.
- **Build:** the **Pass** / **Scan screen** `SegmentedControl` (one draft, one history, one save); `?mode=scan`; the stage
  painting `renderScanDisplay(doc, sampleScope, preview)` through UI's components (C18) at 0.8 in a device frame;
  outcome tabs per template kind; role, theme and device controls; selection synced both ways with the outline, ring,
  type tag and mini toolbar; locked system outlines with reasons; hidden-panel placeholders; the fit meter and per-panel
  units; the version card and the display-only save (`activate: 'display-only'`, the live callout, n5's copy and
  **Activate** otherwise); the overview's **Scan screen** card and the versions list's **Scan screen only** badge; the
  phone page is preview-only.
- **Tests first** (DM §10.6 web): mode switching keeps the draft, history and dirty state; canvas and outline
  selection both ways; system elements give their reason; the Refused tab shows only the notes editor; Heads-up locks
  the header; the fit meter equals `density()`; a hidden panel shows its placeholder; the saved callout per
  `displayOnly`/`activated`; the keyboard flow (add Ticket, bind Seat, add Access, Show when tier is VIP, reorder,
  save) without a pointer; axe at 1440, 820 and 390 in both themes.
- **Done when:** `16-scan-designer` passes.

**TD.5 Designer NFC section** (M4; needs PT.6) — was part of AD.8
- **Files:** `templates/designer/{section-nfc.tsx,ops-nfc.ts}` and the outline registration.
- **Build:** SD §10.5 NFC: the switch, disabled with **NFC needs an approved certificate.** and **Set up NFC** until
  every gate allows it; **Ask for Face ID first**.
- **Tests first:** the switch is disabled when any gate is off; axe.
- **Done when:** M4 exit.

**TD.6 Real-pass sample** (M3; needs DS.5)
- **Files:** `designer/scan/sample.ts`, the sample picker in `scan-stage.tsx`.
- **Build:** **Try another pass** and the pass search use `/api/v1/scan-display/preview`; the scope is labelled with
  the pass; per-input overrides still apply.
- **Tests first:** the role control refetches the scope; a failed preview falls back to the sample with a one-line
  error.
- **Done when:** a rule visibly switches between two real passes.

---

## 6. Integration order

### 6.1 Merge order

```
P0 (P0.1 → P0.7, one merge)
 │
 ├─ M1  PT.1 ─┬─ SV.1 ─ SV.2 ─ SV.3 ─ SV.4 ─ SV.6a
 │            ├─ PT.2 ─ PT.3       PT.4
 │      DS.1 ─ DS.2 ─ DS.3 ─ DS.4   (DS.3 after SV.1's stub; PT.3 after DS.2)
 │      BU.1 ─ BU.2 ─ BU.3 ─ BU.5   UI.1 ─ UI.6 ─ UI.2 ─ UI.3 ─ UI.4
 │      SC.1 ─ SC.2 ─ SC.4          AD.1 ─ AD.2 ─ AD.3 ─ AD.4
 │      CC.1 ─ CC.2 ─ CC.3 ─ CC.4 ─ CC.5                IN.1 ─ IN.2(pair, door, camera, display M1)
 │      ── M1 gate ──
 ├─ M2  SV.5 ─ SV.6b  SC.3   CC.6   UI.5   AD.5   PT.7   TD.1 ─ TD.2 ─ TD.3 ─ TD.4
 │      IN.2(desk, designer, display M2)                                ── M2 gate ──
 ├─ M3  SV.7  SC.5 ─ SC.6 ─ SC.7  PT.5  BU.4  AD.7  DS.5 ─ TD.6  IN.2(admin) IN.3   ── M3 gate ──
 ├─ M4  PT.6 ─ AD.8 ─ TD.5  IN.2(nfc)  IN.3                            ── M4 gate = release candidate ──
 └─ M5  SV.8 ─ CC.7 ─ CC.8  IN.2(offline)                              ── M5 gate ──
```

**Hard edges** (merge after):

| Task | Merges after |
| --- | --- |
| SV.1 | PT.1 (its `buildDisplay` call is a stub until DS.3) |
| DS.3, DS.4 | DS.1 and SV.1 |
| PT.3 | PT.2 and DS.2 |
| SV.5 | PT.1 and PT.2 |
| SV.6a / SV.6b | SV.2 / SV.5 |
| UI.3 | PT.4, CC.1 and UI.6 |
| UI.6 | P0 (C15) |
| BU.3 | BU.1 and CC.1 |
| BU.5 | BU.3 |
| PT.5 | SC.6 |
| AD.2 | SC.1 |
| AD.3 | SC.2 |
| AD.4 | SC.4 |
| AD.5 | SC.3 |
| AD.7 | SC.5, SC.6, BU.4 |
| AD.8 | PT.6 |
| PT.7 | P0 (C19) |
| TD.1 | PT.2 |
| TD.2 | DS.1 and DS.2 |
| TD.4 | TD.3, UI.6 and PT.7 |
| TD.5 | PT.6 |
| DS.5 / TD.6 | DS.3 / DS.5 |
| CC.7 | SV.8 |
| IN specs | the tasks they exercise |

Everything else merges as soon as it is green. Streams develop against the frozen contracts and fixtures, so they
don't wait to start, only to merge.

**Rebasing.**
- Each stream rebases on `next/integration` before every merge request.
- The integration agent merges one branch at a time, and runs `npm run check` and the scanner e2e after each.

### 6.2 Milestone gates

A gate passes when all of these hold:
- `npm run check` is green on `next/integration`;
- that milestone's e2e specs are green;
- the visual check (§10, item 3) passes for that milestone's screens;
- the device checks marked for that milestone (§8.2) are done or logged as blocked with a reason.

---

## 7. Migrations

| No. | File | Stream | Contents |
| --- | --- | --- | --- |
| **0014** | `migrations/0014_scan.sql` | P0.1 | `scan_events`, `scan_event_templates`, `scan_staff`, `scanners`, `scanner_templates`, `scans`, `scan_gates`, `vas_keys`, `passes.lookup_hash` + `passes_lookup_hash`, `passes_org_title`, `passes_org_subtitle`, the `audit_log` rebuild with `scanner`, `scan_events.note` (≤ 140) and the partial index `scans_pass_ok` for display history. Verbatim from SA §6.1 |
| **0018** | `migrations/0018_templates_build_key.sql` | PT.7 (M2) | `template_versions.build_key TEXT` and `template_versions_build (template_id, build_key)`; no backfill (the immutability trigger forbids it; `NULL` keeps today's behaviour). SA §6.1a |

**No ledger or visit table.** The balance ledger, visits and last visit are computed from `scans` (which already holds
`amount`, `before_value`, `after_value`, `action_kind`, `outcome` and `at`) through `scans_pass_ok` (SA D24). No table
stores rendered displays, and `scans` stays free of holder data. No memo column: ledger rows show the action label only
(owner, 2026-11-04).

No other migration is planned. If a stream needs a schema change after P0:
- add `migrations/0019_scan_<topic>.sql` or later (`0017` is reserved for n5, `0018` is PT.7's);
- never rebuild a referenced table;
- never depend on another stream's in-flight migration;
- tell the integration agent in the report.

---

## 8. Risks and device checks

### 8.1 Risks

| Risk | Effect | Mitigation | Owner |
| --- | --- | --- | --- |
| The Cloudflare Vite plugin may not build two HTML inputs, or `/scan` may not serve `scan.html` [U] | No separate document | Found in P0.5 before any stream starts. Fallback: a Worker route that serves `scan.html` from `ASSETS` with the scan headers | P0 |
| Worker CSP on WebKit (the worker takes the document's or the script's policy) [U] | The decoder doesn't compile | Both carry `'wasm-unsafe-eval'`. Verified on a device in M1 | CC |
| zxing-wasm PDF417 speed on iPhone [U] | Slow door | QR and Aztec preferred by the designer banner. STRICH is the fallback vendor (owner call only if the M1 device run fails) | CC |
| Wedge keystrokes reaching Safari with no focused field [U] | Readers don't work | The field sink fallback (`wedge-field.tsx`) | CC |
| `audioSession.type = 'playback'` against the silent switch [U] | Silent chirps | Colour, icon and words carry the result; try `'transient'` | BU |
| Home-screen cookies not copied at install [U] | Re-pairing in the home-screen app | Pair inside the app; the copy says so | UI |
| SPA initial budget overflow | `check` fails | No scanner code in the SPA; raise ≤ 1 kB with a comment | P0, AD |
| Lazy scenes and art kit budgets (12 B / 145 B headroom) | `check` fails | Beats in the scan chunk; measured raises (≤ 2 kB, ≤ 0.25 kB) | BU |
| D1 single writer at a busy venue | Slow verdicts | The fast path (one batch), `RL_SCAN_ORG` 3000/min, no AE on the hot path, round-trip tests | SV |
| The `audit_log` rebuild colliding with another stream's change | A dropped column | IN.4 guard until `0014` merges | IN |
| Contract churn between parallel streams | Rework | §4.1 freeze and the change PR rule; the fixtures in P0.6 | P0 lead |
| Apple declines or delays NFC for a multi-tenant platform | No NFC | Ships off; a DB identity per tenant is the fallback | owner |
| VTAP key-id derivation or config format differs from the docs [U] | A silent reader | Test-a-reader dialog plus the device check before the flag | PT, owner |
| Barcode screenshots (no anti-screenshot for barcodes) | A double admit | The atomic gate; amber with when and where; NFC `requiresAuthentication` later | SV |
| The owner picks another direction ("A at the door, B at the desk") after the build starts | Rework | Only UI and BU carry the direction (§3); the contracts, renderer, editor and server don't change | UI, BU |
| A valid display doesn't fit the phone card | Scrolling at the door | The per-screen budget counts the header (DM §1.6); UI.6's fit test per screen; if it fails, DS lowers the constants, never the type size. At paint time the body scrolls under a fixed band, so the verdict never moves | UI, DS |
| The phone keypad tray shortens the card under a Balance panel | The ledger hides the draft | The history row shows its newest item while the tray is open (DM §1.2); UI.5 renders the tray first | UI |
| A different code accepted at T0 + 350 strobes the screen or snaps the buddy | Flicker, a jumpy buddy | One tint change per 350 ms at most (under 3 per second); the swap tucks behind; BU's snap test at a 350 cut | CC, UI, BU |
| `backdrop-filter` over live video drops frames on older iPhones [U] | A janky camera | Glass only on the capsule and live pill; opaque fallback under `prefers-reduced-transparency`; measured on an iPhone 12 in M1 | UI |
| A display render error at the door | A missing card body | `buildDisplay` never throws; the default display and one log (DS.3) | DS |
| Bound text leaking data to a role | Privacy | Role filter on the doc and the scope before evaluation; secrets never in scope; tests per role (DS.1, DS.3) | DS |
| Editor ops colliding with n5's designer changes | Merge pain in shared designer files | TD is the only stream in the designer; each hook under 20 lines; rebases on n5 first | TD |

### 8.2 Real-device checks (manual; results in each milestone's report)

**iPhone**, Safari and the home-screen app, current iOS, 390 × 844:
- **M1:**
  - QR and PDF417 decode times from another phone's screen;
  - **camera glare:** a pass at full brightness under venue-like light, at 20, 35 and 50 cm, tilted 0° and 20°;
  - the hints at 4, 8 and 12 s;
  - lens pick and torch;
  - wake lock;
  - chirps with the silent switch on and off, and with headphones;
  - the camera re-prompt on relaunch;
  - pairing inside the home-screen app;
  - 20 different codes back to back at a 350 ms cadence: one card, no stacked props, no double tones;
  - **arm's length:** every verdict read at 60 cm and at 2 m, in a lit room and a dark one (tint, ring, 40 px headline,
    glyph shape), light and dark theme;
  - `backdrop-filter` and the card rise over live video on an iPhone 12: no dropped frames in a 30 s trace;
  - the VIP, coffee and prepaid displays (DM §8) fit without scrolling at the default and at the largest Dynamic Type
    size the page honours;
  - reduced motion on and off.

**iPad**, 1180 × 820 and 820 × 1180:
- **M1:**
  - a stand with the front camera (the guest-facing copy);
  - a Bluetooth barcode reader typing into the page with no focused field, and then with the lookup field focused;
  - a German keyboard layout set on the iPad (the `event.code` mapping).
- **M2:** a Magic Keyboard covering the desk keypad, arrows, Esc and `/`.

**NFC** (M4, needs the owner's VTAP100):
- the VTAP100 in keyboard mode on iPad and on a USB-C iPhone;
- a reader key loaded from **Make reader key**;
- the key id seen equals the console's;
- two orgs on one pass type ID, where org B's pass stays silent on org A's reader;
- the silent-failure hint after 8 s.
- Before Apple approves, only the wedge path and the Test-a-reader dialog can be checked.

**Desktop:**
- **M1:** a webcam in Chrome and Safari; a USB barcode reader.

---

## 9. e2e specs to add

All under `e2e/`, using `e2e/helpers/scan.ts`. Reduced motion is the default; one spec runs with motion on.

| Spec | Milestone | Covers |
| --- | --- | --- |
| `16-scan-shell.spec.ts` | P0/M1 | `/scan` loads `scan.html`; headers: `camera=(self)`, CSP with `worker-src 'self'` and `'wasm-unsafe-eval'`, `no-referrer`; SPA pages keep `camera=()`; an unpaired device sees **Pair this device** |
| `16-scan-pair.spec.ts` | M1 | Console New scanner, then the pairing face, then a second context opens `/scan#pair=…`; no code left in the URL; confirm, Pair, console shows **Paired**; revoke gives the block panel **Scanner removed** |
| `16-scan-door.spec.ts` | M1 | Start; an injected read checks in (green, count 1); the same code within 5 s gives the chip and no second ledger event; after 5 s amber with **Done** focused, **Let in again** gives green; voided and test pass refused; a wedge burst (`keyboard.type(code, { delay: 5 })` + Enter) checks in; lookup by name opens the desk panel and checks in; undo from the dock strip; a different code while a card is up swaps it (`data-phase`) and the camera keeps decoding; `setOffline(true)` gives slate with no request; an aborted response gives **Not confirmed**, then exactly one ledger event after reconnect; two contexts scan one ticket concurrently, giving one green and one amber |
| `16-scan-camera.spec.ts` | M1 | Project `scan-camera`: the y4m QR of a seeded pass decodes through the real worker, CSP and wasm fetch, and checks in |
| `16-scan-display.spec.ts` | M1 (door), M2 (desk, live edit) | M1: a template made from the Event ticket blueprint shows its Ticket panel; a template with no display shows Details; the VIP doc (crown with the check badge, **VIP** and **Table 12** chips, a 4-column Ticket on one line, Access) at the door; the same pass on a Door scanner without the row marked `minRole: desk`; a voided pass shows the compact row and the refused note only; the event note on amber. M2: a Stamp card at 7 gets +2 (7 → 9); a second Stamp card issued at 9 gets +1 and shows the caption **1 reward ready** and **Redeem reward** as the dock's primary (no button in the card) (a second pass, because Add stamp's 5-minute cooldown would stop a second add on the first); a display saved with `activate: 'display-only'` shows on the next scan, the pass version unchanged |
| `16-scan-designer.spec.ts` | M2 (M3: real pass) | Open from the template page (**Edit scan screen**), build the VIP display (add Ticket, bind Seat, add Access, Show when tier is VIP, the VIP rule with the crown and chips), save: it goes live, display-only, and no pass version is created; the title **Welcome back, {First name}** (the title's picker offers only **First name** and **Full name**) shows on 2 lines; scan with a test scanner and see it; a pass whose `attendee` is "Refunded" shows only **Checked in** in the band (the name check); the same editor from the event page's **Result screen · Edit**; a phone viewport shows the preview only; the keyboard-only flow; M3: preview with a real pass |
| `16-scan-desk.spec.ts` | M2 | A desk scanner opens a Stamp card, adds 2 stamps through the stepper and review, then undoes; charges a Balance card with an amount on the phone keypad tray (ledger rows read **Charge**); redeems a reward on a Stamp card issued at 10 (back to 0); a Door staff member signs in with a PIN, tries **Set balance**, gets **Ask a manager**, and a Manager PIN approves; a wrong PIN shows tries left |
| `16-scan-admin.spec.ts` | M3 | Create an event, assign a scanner; the dashboard shows the check-in within one poll; the Scans tab filter by reason; export CSV is audited; the pass Sync log **Scans** filter; the broadcast audience "Not checked in" count |
| `16-scan-nfc.spec.ts` | M4 | NFC card states with the flag off; a reader key made in the browser (the SPKI posted, the private key never sent); Test a reader with a typed burst; a wedge read on a `reader: 'nfc'` scanner records `method: 'nfc'` |
| `16-scan-offline.spec.ts` | M5 | Roster loaded; offline check-in gives **Saved offline**; reconnect syncs; a conflicting online scan gives `already_done` after the fact; a v3 cold offline load shows Start |
| `16-scan-a11y.spec.ts` | M1-M3 | axe (`wcag2a`/`aa`/`21aa`/`22aa`, serious and critical fail) on pair, Start, aiming, each verdict kind, each owner example display, lookup, desk panel, action area, PIN panel, shift summary, the four admin tabs and the designer's Scan screen mode, at 390 × 844, 820 × 1180, 1180 × 820 and 1440 × 900, light and dark |

---

## 10. Definition of done

**The wave (M1-M4) is done when all of these hold:**

1. **`npm run check` is green on `next/integration`**: gen, biome, log codes, sizes, SQL owner, knip, typecheck,
   unit/worker/web tests, the build, the SPA budget (≤ 232,500 B or a ≤ 1 kB commented raise), the scan budget
   (≤ 150,000 B), and `wrangler deploy --dry-run`.
2. **Every `16-scan-*` spec for M1-M4 is green.** `16-scan-a11y` has zero serious or critical axe violations.
3. **Visual check** at **390 × 844, 820 × 1180, 1180 × 820 and 1440 × 900, light and dark**, touch and fine pointer:
   - every `/scan` result, desk and shell state matches the B-strengthened sheets (`docs/design/scanner/b-final/`);
     states BF doesn't render match SD §5 in the B shell (SD §14 "renders still owed");
   - the Scan screen editor matches `docs/design/scanner/display/` with SD §14's three model corrections;
   - every admin page of SD §10 matches the admin sheets (`docs/design/scanner/mockups/`);
   - no horizontal scroll at 390 or at 320 with 200 % zoom;
   - no layout shift across a verdict (the capsule chips, the dock strip, the card's bottom edge and the buddy seat
     keep their boxes);
   - one buddy in view, on the dock;
   - control sizes: BF's in the capsule, card and dock; 14 px text, 36 px controls, and 44 px with 16 px field text
     on touch in sheets, dialogs and the admin.
   - Screenshots go in the milestone report.
4. **Motion**: transform and opacity only; the card rises from the violet pass and tucks back per BF; a different code
   from T0 + 350 swaps it; reduced motion cross-fades in 120 ms and shows stills; the beat is still by T0 + 700; the
   next scan cuts it in one frame (BM tests green).
5. **Result display**:
   - the DM §1.11 safety tests and the role tests pass; no display renders a control; refusals show only the refused
     note; system copy comes from `SCAN_COPY` only;
   - the fit test passes per screen for the largest composition the budget admits and for the six owner examples at
     390 × 844; at 200 % text the body scrolls and the band stays put;
   - every blueprint's display validates and has snapshots; a template with no display renders the Details default;
   - a display-only save goes live on the next scan with no pass version, push or R2 write;
   - the direction is isolated: the `scan-display/**` lint test passes, and no file outside UI and BU's paths holds a
     size, colour or motion value for the result screens.
6. **Security**:
   - the tenant-isolation, mode and OpenAPI-loop tests pass;
   - the suite-wide log and audit scan finds no `@`, `wls_`, 26-char scan code, PIN or rendered display string;
   - no display scope holds an email, phone, scan code, barcode or token for any role;
   - `nfc.enabled` is false everywhere.
7. **Docs**: `docs/api.md` (with **Result screens in templates**), `operations.md` and `security.md` are updated; the `AGENTS.md` rows match §3; the
   scanner design docs are in `docs/design/scanner/`.
8. **Device checks** of §8.2 for M1-M3 are done, with results logged. NFC device checks wait for the owner's hardware
   and are logged as open.
9. **Reports**: each stream's report lists the shared files it changed and any contract change PRs.

**M5 is done** when `16-scan-offline` is green and the offline device run (an iPhone in airplane mode, reconnecting)
is logged.

---

## 11. For the owner

Everything else is decided in the design docs and this plan. These are genuinely yours, and none blocks the build:

1. **The Apple NFC application** for `pass.im.plrs.wallet`, naming the Dot Origin VTAP100. It takes 2-8 weeks.
2. **Hardware for device checks:** one VTAP100 (GBP 139) and one Bluetooth barcode reader. Without them, reader input
   ships tested only on desktop.
3. **The personalization fix** before `nfc.enabled` is ever turned on.
4. **Confirm B strengthened** for the result screens. Building can start now: if you later want "A at the door, B at
   the desk", only UI and BU change (§3).
5. **Staff names in history rows**: off for now; a later, additive change (SA §17).

Settled by the owner, 2026-11-04: names in the band (the holder's name only, 2 lines for 1 more unit); the Balance
card and Stamp card blueprints; no item names in the ledger.
