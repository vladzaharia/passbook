# Phase 0 amendments: stations, Access cards and occupancy

> **Revision 2026-11-05, later** (occupancy and desk overrides, SA §20, `occupancy/occupancy.md` **OC** §9): two more
> items, **P0-9** (two CHECK values on `scans` in `0014`) and **P0-10** (two heads-up reasons and their default copy).
> OC proposed four more (P0-11 to P0-14); they are additive, so they land with stream OC and SV, not in P0 (see "Not in
> P0"). Checked against `next/n8-p0` at `18ca03c`: `scans.actor_type` is `('scanner', 'user')`, `scans.method` is the
> four input methods, and the guard's `screens?: boolean` is built.
>
> **Review 2026-11-05, latest:** re-checked at `9f1d57f` (read-only): both CHECKs still lack the values, and
> `capacity_full` reads **Event full** with no placeholder. P0-10 no longer changes `capacity_full`'s copy: that was
> a string change, not a reason-list change, and a `{place}` marker that a caller forgets shows as **{place} full**
> (`scanLine` keeps missing markers). Zones get **{zone} full** as an OC.1 variant; events keep **Event full**. P0
> is now two CHECK values and two reason keys.

The changes Phase 0 takes before it merges, so stations (`stations.md`, **ST**) and Access cards (`access.md`,
**AX**) land later without a table rebuild or a break in a frozen contract. 2026-11-05. Checked against
`next/n8-p0` at `eca97b3` (0014 committed on the branch, not merged; 0015 and 0016 already on `next/integration`).
Everything not listed here lands additively in streams ST and AX (`scanner-plan.md` §5.11-5.15).

Each item: files, change, tests. Ids in brackets are the source rows (ST §8 A1-A7, AX §7 N1-N6). All edits stay
inside P0's owned paths plus the two foundation files P0 already touches.

## Summary

| # | Area | Files | Source |
| --- | --- | --- | --- |
| P0-1 | Migration 0014: device kind and role | `migrations/0014_scan.sql`, `test/migrations.test.ts` | A1 |
| P0-2 | Principal carries kind and role | `src/worker/platform/auth.ts`, `src/worker/modules/scan/auth-store.ts`, `test/helpers/fake-auth.ts` | A2, A4 |
| P0-3 | Guard refuses screens | `src/worker/modules/scan/guard.ts`, `guard.test.ts` | A3 |
| P0-4 | Console and session contracts | `src/shared/contracts/{scanners,scan-session}.ts` | A5 |
| P0-5 | Access reasons, outcome field, copy | `src/shared/contracts/scan.ts`, `src/shared/copy/scan.ts`, `scan.test.ts` (both) | N1, N2, N3, A6 |
| P0-6 | Manifest `access` key and `scanOf` | `src/passkit/types.ts`, `src/shared/scan-defaults.ts` (+ test) | N4 |
| P0-7 | Display doc: `customer` block, two icons | `src/passkit/template/scan-display/{schema,icons}.ts`, `schema.test.ts` | A7, N6, AX C1 |
| P0-8 | `/scan` headers | `src/worker/platform/security-headers.ts`, `public/_headers`, `security-headers.test.ts` | ST §8 note |
| P0-9 | Migration 0014: system scans | `migrations/0014_scan.sql`, `test/migrations.test.ts` | OC P0-9 |
| P0-10 | Occupancy reasons and copy | `src/shared/contracts/scan.ts`, `src/shared/copy/scan.ts`, `scan.test.ts` (both) | OC P0-10 |
| — | Audit actors | none | — |
| — | Rate limits | none | — |

Size: about 120 changed lines plus tests (P0-9 and P0-10 add about 15). No new route, table, binding or dependency.

---

## P0-1. Migration 0014: device kind and role [A1]

`scanners` in `migrations/0014_scan.sql`:

```sql
  kind TEXT NOT NULL CHECK (kind IN ('device', 'terminal', 'display')),
  -- what the device does now: scan, face a customer, or watch scans. A display never scans; a terminal always does.
  device_role TEXT NOT NULL DEFAULT 'scan' CHECK (device_role IN ('scan', 'customer', 'monitor')),
  ...
  CHECK ((token_hash IS NULL) = (token_prefix IS NULL)),
  CHECK (kind <> 'terminal' OR csrf_secret IS NULL),
  CHECK (kind <> 'terminal' OR device_role = 'scan'),
  CHECK (kind <> 'display' OR device_role <> 'scan')
```

- Replaces `CHECK (kind = 'device' OR csrf_secret IS NULL)`: a display is a cookie device and needs its CSRF secret.
- The column is `device_role`, not ST's `role`: `scan_staff.role` and `ScanActor.role` already mean the staff ladder
  (Door, Desk, Manager). Every later doc uses `device_role` / `deviceRole`.
- Both CHECKs sit on `CREATE TABLE scanners`. Changing them after merge means rebuilding `scanners`, which has children
  (`scanner_templates`, later `scanner_zones`).

Tests, in `describe('0014_scan migration')`:
- a `display` row with `device_role = 'scan'` fails; with `'customer'` and `'monitor'` it inserts;
- a `terminal` with `device_role = 'customer'` fails; a terminal with a `csrf_secret` fails;
- a `display` with a `csrf_secret` inserts; `device_role` defaults to `'scan'`.

**If 0014 has merged before this lands** (fallback, no rebuild): `0019_scan_stations.sql` adds
`device_role TEXT NOT NULL DEFAULT 'scan' CHECK (device_role IN ('scan','customer','monitor') AND (kind <> 'terminal'
OR device_role = 'scan'))` and `screen_only INTEGER NOT NULL DEFAULT 0 CHECK (screen_only IN (0,1) AND (screen_only = 0
OR (kind = 'device' AND device_role <> 'scan')))`; screens are `kind: 'device'` with `screen_only = 1`, and the
contracts map `screen_only = 1` to `kind: 'display'`. Verified on SQLite 3.54 (ST §7.1).

## P0-2. Principal carries kind and role [A2, A4]

```ts
// src/worker/platform/auth.ts (foundation file; P0 already edits it)
export interface ScannerAuth {
  kind: 'scanner';
  scannerId: string;
  orgId: string;
  mode: Mode;
  transport: 'cookie' | 'bearer';
  csrfSecret: string | null;
  scannerKind: 'device' | 'terminal' | 'display';   // new
  deviceRole: 'scan' | 'customer' | 'monitor';      // new
}
```

- `modules/scan/auth-store.ts`: `resolve` selects `kind` and `device_role` in the statement it already runs (no extra
  read). A bearer token on a non-terminal row stays 401 as today.
- `test/helpers/fake-auth.ts`: `fake.scanner({ scannerId?, kind?, deviceRole? })`, defaults `device` and `scan`, so
  every existing call keeps working.

Tests: `auth-store.test.ts` resolves a display row with both fields; `fake-auth` test for the defaults.

## P0-3. Guard refuses screens [A3]

`requireScanActor` order becomes (SA §2.5):

1. Credential (and CSRF for cookies).
2. `isOrgActive`.
3. `RL_SCAN_ORG`, then `RL_SCAN`.
4. **Device role** (new): a scanner principal whose `deviceRole ≠ 'scan'` gets 403 `SCREEN_ONLY`, unless the route
   opts in with `GuardOptions.screens: true`.
5. Staff binding.

- After the rate limits on purpose: a misbehaving screen is throttled like any device, and an inactive org answers
  `ORG_INACTIVE` first, so every face shows the same block panel.
- `screens: true` on `GET /scan/session` and `POST /scan/unpair` only. Later, SV.9 sets it on the asset route too
  and refuses `customer` there itself (monitors read photos with an audience grant); no P0 change for that. Stations add `GET /scan/live*` and
  `POST /scan/role` later with their own guard (`requireLivePrincipal`, ST §4.8), not through this option.
- Admin sessions have no device role and are never refused here.
- Error: `ForbiddenError('This device is a screen.', 'SCREEN_ONLY')`; `reportDenied` as for other 403s.

Tests (`guard.test.ts`, `fake.scanner({ deviceRole: 'customer' })` and `'monitor'`):
- 403 `SCREEN_ONLY` on `POST /resolve`, `POST /actions`, `POST /lookup`, `POST /scans/{id}/undo`, `GET /scans`,
  `GET /stats`, `GET /summary` and the asset route;
- 200 on `GET /scan/session`, 204 on `POST /scan/unpair`;
- a suspended org still answers `ORG_INACTIVE` for a screen; a rate-limited screen answers 429 before `SCREEN_ONLY`.

## P0-4. Console and session contracts [A5]

`src/shared/contracts/scanners.ts`:

```ts
export const ScannerKindSchema = z.enum(['device', 'terminal', 'display']);
export const DeviceRoleSchema = z.enum(['scan', 'customer', 'monitor']);
export const ScannerSchema = z.object({
  ...,
  kind: ScannerKindSchema,
  deviceRole: DeviceRoleSchema,                 // new
  accepts: ScannerAcceptsSchema.nullable(),     // null only for kind 'display'
  ...
});
```

- `CreateScannerSchema.kind` stays `z.enum(['device', 'terminal'])` in P0: creating a display is ST.1, and widening an
  input enum later is additive. The output DTO widens now because AD and SC read it.
- `src/shared/contracts/scan-session.ts`: `scanner.kind` uses `ScannerKindSchema`; `scanner.deviceRole:
  DeviceRoleSchema`. The boot gate can branch on it from M1 (UI shows the `SCREEN_ONLY` panel until ST ships faces).

Tests: contract tests parse a display DTO with `accepts: null`; the session fixture gains `deviceRole: 'scan'`; the
OpenAPI snapshot updates.

## P0-5. Access reasons, outcome field, copy [N1, N2, N3, A6]

`src/shared/contracts/scan.ts`:

```ts
export const SCAN_REFUSED_REASONS = [
  ...,                       // the twelve today
  'zone_not_included',
  'outside_hours',
  'guest_expired',
  'guest_visits_used',
  'suspended',
] as const;

export const ScanAccessSchema = z.object({
  plan: z.object({ id: z.string(), label: z.string(), kind: z.enum(['always', 'timed', 'guest']) }),
  zone: z.object({ id: IdSchema, name: z.string() }).nullable(),
  closesAt: TimestampSchema.nullable(),
  nextOpenAt: TimestampSchema.nullable(),
  visits: z.object({ used: z.number().int(), limit: z.number().int().nullable() }).nullable(),
  visit: z.boolean(),
  timeZone: TimeZoneSchema,   // the deciding zone's clock; the client formats {time} and {when} with it
});
// ScanOutcomeSchema and ScanCardSchema gain:
access: ScanAccessSchema.nullable().default(null),
```

- The reason list stays unbound to kinds, so `not_yet_valid` can arrive as `refused` on access templates (AX §1.3)
  with no contract change.
- `timeZone` is required, not optional: a zone's site can sit in another time zone than the scanner's `time_zone`
  (an admin in New York sets up a Seattle door), and adding it after the freeze would make every client guess.
  `TimeZoneSchema` already exists in `contracts/scan.ts`.
- Fixtures stay valid through the default.

`src/shared/copy/scan.ts`:

| Key | Headline | Sub |
| --- | --- | --- |
| `zone_not_included` | **Not in plan** | **{plan} doesn't include {zone}.** · no zone: **{plan} opens no zone here.** |
| `outside_hours` | **Outside hours** | **{plan} opens {when}.** · none in 7 days: **{plan} has no hours this week.** |
| `guest_expired` | **Guest pass ended** | **Ended {time}.** |
| `guest_visits_used` | **No visits left** | **Used {limit} of {limit}.** |
| `suspended` | **Suspended** | **Ask them to see the front desk.** |
| `SCAN_OK_COPY.access` | **Access granted** | `{zone}` · `{zone} · until {time}` · none |
| error `SCREEN_ONLY` | **This device is a screen.** | **Ask an admin to change it.** |

Tests: the existing "every reason has a line" test covers the five; a test that each new sub's placeholders are only
`plan`, `zone`, `when`, `time`, `limit`; the error copy test gains `SCREEN_ONLY`.

## P0-6. Manifest `access` key and `scanOf` [N4]

- `src/passkit/types.ts` (a2's file; P0.2 already edits it): `ScanManifest.access?: AccessManifest` with
  `AccessManifest`, `AccessPlan`, `AccessGrant`, `WeeklyHours` exactly as AX §2.2. Types only.
- `src/shared/scan-defaults.ts`: `scanOf` resolves every `check_in` action to `repeat: 'always'` when
  `manifest.access` is set (no `once`, no `daily`, no `already_done` on an access template).
- The manifest validator (`SCAN_SHAPE`, PT.2) accepts the `access` key when it is built; `accessIssues` (AX.1) checks
  its body. Nothing to do in P0 beyond the type.

Tests (`scan-defaults.test.ts`): a `check_in` with `repeat: 'once'` on a template with `access` resolves to `always`;
without `access` it stays `once`.

## P0-7. Display doc: `customer` block, two icons [A7, N6, AX C1]

`src/passkit/template/scan-display/schema.ts`, on the strict `ScanDisplayDocSchema`:

```ts
customer: z.strictObject({
  greet: z.boolean().optional(),                // default true
  chips: z.array(IdSchema).max(18).optional(),  // ≤ 2 per header: base or one variant (validator, DS)
  panel: IdSchema.nullable().optional(),
}).optional(),
```

`max(18)` is 2 chips × (the base header + 8 variants); only one header renders, so a customer sees at most 2. The
per-header cap, references, allow-listed rows and the customer scope are validator rules (DS, `customerIssues`,
ST §3.2), not schema.

`src/passkit/template/scan-display/icons.ts`: `SCAN_ICONS` gains `infinity` (Lucide `Infinity`) and `clock` (Lucide
`Clock3`), 40 → 42. They are the Access card's plan chips.

Tests: `schema.test.ts` parses the Access card's doc (`addendum/access/pass/starter-access-card/wallet.template.json`,
copied as a fixture) with its `customer` block; 19 chip ids fail; an unknown key in `customer` fails; the icon list
test counts 42. `node addendum/access/gen/check-package.mjs` then passes with no swaps.

## P0-8. `/scan` headers (optional in P0)

Not needed for the freeze. Take it only if P0.5 is still open; otherwise IN.6 adds the line with the hub binding. The
device check below stays in P0.5 either way, because its answer decides the CSP before ST starts.

- `Permissions-Policy` on `/scan` (`SCAN_PERMISSIONS_POLICY` and `public/_headers`) adds `screen-wake-lock=(self)`.
  Today the feature is unlisted, so it defaults to self; naming it keeps customer screens and monitors awake if anyone
  later tightens the list.
- `connect-src 'self'` stays. CSP Level 3 matches same-origin `wss:`; the live socket needs nothing else.
- Test (`security-headers.test.ts`): the `/scan` policy contains `screen-wake-lock=(self)` and `connect-src 'self'`;
  the SPA policy is unchanged. P0.5's device check list gains: open a WebSocket to `/api/v1/scan/live` from `/scan` in
  Safari and the home-screen app on iOS 17+ (any response counts; the route arrives with ST). If WebKit blocks it, add
  `wss://passbook.mobile wss://wallet.plrs.im` to both policies.

## P0-9. Migration 0014: system scans [OC P0-9]

`scans` in `migrations/0014_scan.sql`:

```sql
  actor_type TEXT NOT NULL CHECK (actor_type IN ('scanner', 'user', 'system')),
  ...
  method TEXT NOT NULL CHECK (method IN ('camera', 'wedge', 'nfc', 'manual', 'auto')),
```

- Auto tap-outs (Max stay, Clear at; SA §20.7) are scans written by the cron: actor `system`, `actor_key
  'sys:occupancy'`, method `auto`. Both CHECKs sit on `CREATE TABLE scans`; after the merge, adding the values means
  rebuilding the busiest table, which `scan_gates` and the ledger point at.
- **Must land before the merge.** OC's reference test (`occupancy/gen/occupancy.test.mjs`, first case) applies
  next/n8-p0's real migrations and shows the auto tap-out insert failing without it.
- Contracts don't change: `ScanMethodSchema` stays the four input methods (`auto` is never accepted on input); the
  console DTO's method and actor widen with stream OC (SC.10), additively.

Tests, in `describe('0014_scan migration')`: a scans row with `actor_type = 'system'` and `method = 'auto'` inserts;
`actor_type = 'robot'` and `method = 'robot'` fail.

## P0-10. Occupancy reasons and copy [OC P0-10]

`src/shared/contracts/scan.ts`:

```ts
export const SCAN_HEADS_UP_REASONS = [
  ...,                 // today's list
  'still_inside',      // Already in: a second entry where tap-out is required, or an Auto flip under 2 min
  'not_inside',        // Not tapped in: an exit with no entry, or a zone whose parent needs a tap-in first
] as const;
```

`src/shared/copy/scan.ts` (`SCAN_REASON_COPY`, one default line each):

| Key | Headline | Sub |
| --- | --- | --- |
| `still_inside` | **Already in** | **Since {time} · {scanner}** |
| `not_inside` | **Not tapped in** | **No entry recorded.** |

`capacity_full` is unchanged (**Event full** · **{in} of {capacity} in.**).

- Freezes the reason list once, as P0-5 did: copy maps are `Record<ScanReason, …>`, so a later widening would touch
  every consumer.
- The variants (events **Already checked in** / **Not checked in**, Auto **Already out**, the parent's **Tap in at
  {zone} first.**, **{ago} · {scanner}** under an hour, and zones' **{zone} full**) are an additive map with OC.1
  (SA §20.10).

Tests: the "every reason has a line" test covers the two; their placeholders are only `time` and `scanner`;
`capacity_full` still reads **Event full**.

## Not in P0 (OC's P0-11 to P0-14: additive, later)

| OC item | Lands in | Why not now |
| --- | --- | --- |
| P0-11 `ScannerSettings.direction` (default `in`) | OC.1 / SC.10 | An optional field with a default, like `customerToggle` (below): existing rows parse unchanged |
| P0-12 `ScanOccupancySchema`; `ScanOutcome.occupancy`, `ScanCard.occupancy`, `ScanCounts.place` | OC.1 (contract PR) | Nullable with a default: additive under plan §4.1; no screen paints it before M3B |
| P0-13 copy: `tappedOut`, `tapIn`, `tapOut`, `markAsOut`, `letIn`, `signInToAct` | OC.1 | New keys, not a reason-keyed map |
| P0-14 `GuardOptions.screens` → `'read' \| 'act'` | SV.11, as a new option `screenActions?: boolean` | Changing a built option's type is not additive; a second option is. `screens: true` keeps its meaning |

## Not changed, on purpose

- **Audit actors.** Customer screens and desk monitors are rows in `scanners`, so they audit as `scanner` (already in
  0014's `audit_log` rebuild). Zone, station and role changes from the console are `user`. No rebuild, no new type.
  New action names (`scanner.role_change`, `scan_station.*`, `scan_zone.*`, `pass.access_visits_reset`) are strings
  added with their streams, with labels in `admin/audit/labels.ts`.
- **Rate limits.** No new binding. The live upgrade and catch-up run under `RL_SCAN` (240/min per device): the 2 s
  catch-up poll is 30/min. Beats are socket messages, capped in the hub (10/s). Flip-back PINs reuse
  `scan:pin:*` and `scan:pinall:*`. Display pairing reuses `RL_SCAN_PAIR`.
- **Zones, plans, stations, the hub.** All additive later: `0019_scan_stations.sql` (ST), `0020_scan_access.sql`
  (AX), `contracts/{scan-live,access}.ts`, the `SCAN_HUB` binding.
- **`scan_gates`.** Scope `'access'` is a value; no change. Occupancy's scopes (`zone:<id>`, `event:<id>`) are values
  too; `due_at` and its index come with `0020` (SA §20.13), additive.
- **Occupancy tables and indexes.** `scan_zones` occupancy columns, `scans.out_cause`, `scans.override_note`,
  `scans_override_once`, `scan_gates.due_at`, `scan_place_revs`: all in `0020_scan_access.sql` as extended (AX.1),
  additive on SV's tables.
- **Rate limits for overrides.** `scan:ovr:<actorKey>` is a D1 counter (`platform/counters.ts`), added with OC.3; no
  binding.
- **`ScannerSettings`.** `customerToggle` arrives with ST.5 as an optional field with a default.

## Order inside P0

P0-1 with P0.1 (the migration task), P0-2 and P0-3 with P0.3-P0.4, P0-4 to P0-7 with P0.2 (contracts), P0-8 with P0.5,
P0-9 and P0-10 as plan task P0.9.
If P0.1-P0.4 are already committed on `next/n8-p0` (they are at `eca97b3`), add one commit per item on the branch
before the P0 merge: `feat(scan): display devices and device roles in 0014`, `feat(scan): screens refused by the scan
guard`, `feat(scan): access reasons and outcome field`, `feat(scan): customer block and plan icons`,
`feat(scan): wake lock on /scan`, then `feat(scan): system scans for occupancy in 0014` and `feat(scan): occupancy
reasons and copy`. `npm run check` after each.
