# Access card: blueprint, zones and access types

> **Folded 2026-11-05** into SA §19, DM §11, SD §17, BM §6.1 and the plan (§5.12, §5.15, M2A); those win. The
> package's chip ids now match §4.4 (`c_plan`, `c_timed`, `c_guest`; `check-package.mjs` passes); e2e is
> `16-scan-access`; Phase 0 changes: `p0-amendments.md`.

Architecture and product design for door access (gyms, offices, clubs) on PassBook's scanner. 2026-11-05. Status:
decided, ready to build after Phase 0 merges.

Cited as **SA** `scanner-architecture.md`, **SD** `scanner-design.md`, **DM** `directions/display/display-model.md`,
**BF** `directions/b-final/README.md`, **BM** `buddy-motion.md`, **PLAN** `scanner-plan.md`, **TI**
`../template-identity/spec.md`, **ST** `addendum/stations.md` (stations, customer screens, monitors), **RT**
`addendum/cloudflare-realtime.md`. Paths in code blocks are repo paths. **[U]** = verify on a device or with Apple.

Files here:

| Path | What |
| --- | --- |
| `access/gen/access-eval.mjs` + `.test.mjs` | Reference implementation of the decision (hours, DST, zones, guests, the visit gate, the hours text). `node --test access/gen/access-eval.test.mjs`: 24 cases, all pass. It is the spec in code for `src/passkit/template/access/**` |
| `access/pass/starter-access-card/` | The blueprint package: `wallet.template.json`, `pass.json`, `en.lproj/pass.strings` |
| `access/pass/art/` | Thumbnail (three nested door arches in the foil hues), icon, logo; a sample member photo for mockups |
| `access/gen/check-package.mjs` | Parses the package's `scan.display` with Phase 0's frozen schema (`wt/n8-p0`, read-only) and lints the access block |
| `access/gen/fragments.mjs` | Real `PassCard` stills of the blueprint and three member passes, Lucide icons, app CSS |
| `access/admin/` | Console mockups: Zones tab, zone dialog, plan editor, pass form, scanner zones (section 9) |
| `pages/a-*.html`, `shots/a-*.png` | Scanner result mockups (the mockup stream's; section 9 lists them) |

---

## 0. Decisions

| # | Decision |
| --- | --- |
| X1 | **Access is a policy on a template, not a new action kind.** A template with `scan.access` turns its `check_in` actions into door grants: repeat `always`, no `already_done`, the verdict **Access granted**. `ScanActionKind` stays the frozen five. |
| X2 | **Plans live in the template; each pass picks one.** `scan.access.plans` (1-12): **24/7** (`always`), **Timed** (weekly hours) and **Guest** (a window and an optional visit limit). Per pass: the plan, add-on zones, a start, an end, a visit limit and a sponsor. Hours are never per pass. |
| X3 | **Zones are org data.** `scan_zones`: name, key, optional parent (≤ 3 levels below a root), a time zone on roots. Not per mode: a test scanner opens the same pool. Plans grant zones by **key** (or `*`), so templates stay portable and blueprints grant `*`. |
| X4 | **A scanner checks 0-8 zones.** It grants when the pass opens **any** of them now. No zones means "any zone the pass opens". A grant on a parent opens its children; the **nearest** grant decides the hours; a grant's hours only narrow the plan's (intersection). |
| X5 | **Hours are wall-clock in the zone's time zone** (nearest root zone, else the org's, else the scanner's), evaluated with `Intl` at scan time. DST: a span starting in the spring gap opens when the gap ends; the repeated autumn hour is open both times. **Holidays are out of scope** in v1 (seam in 2.6). |
| X6 | **Every grant records a scan; a visit is a grant more than `visitGapMinutes` (default 120) after the last.** One atomic gate row per pass (`scan_gates`, scope `access`) counts visits, enforces the guest limit and the optional re-entry wait in one UPSERT. History (`visits this month`, `last visit`) is computed from `scans.visit = 1`. |
| X7 | **Anti-passback is not offered. An optional re-entry wait is, default off.** True anti-passback needs exit reads; one-reader gyms would lock out members who stepped outside. The wait (1-240 min) stops a phone being passed back through a door; it answers amber `cooldown` ("Entered 2 min ago"). The photo is the main anti-sharing control. |
| X8 | **Denials are red refusals** with five new reasons: `zone_not_included`, `outside_hours`, `guest_expired`, `guest_visits_used`, `suspended`; plus `not_yet_valid` answered as `refused` on access templates. The buddy shakes its head (M12). A Manager may **Let in anyway** on the four soft ones (2.8); hard ones (voided, removed, expired, suspended, test/live) are never overridable. |
| X9 | **One scanner can do both.** Per template: an access template scanned by a template scanner grants access; a ticket template on the same scanner checks in once. A scanner on an **event** checks every template in once per event, access cards included (a members' night), with zones and hours off. |
| X10 | **The Access card blueprint is generic style, Cobalt.** Photo as the per-pass thumbnail (the ID check on the face and on the scanner), plan in the header, zones and end date on the front, barcode `{{pass.scanCode}}`. Its scan display shows the photo, a plan chip and a Visits panel. The buddy's grant beat is **`gate`**: it lifts its gold pass like a barrier arm and waves you through. |
| X11 | **Migration `0020_scan_access.sql`** (additive). ST holds `0019`. Phase 0 takes six small amendments now (section 7) so the reasons, copy, manifest key and icons are frozen once. |

---

## 1. Semantics

### 1.1 A grant

A scan of an access-template pass by a template scanner, through SA §2.6 with the access steps of 3.4, ends in:

| Result | Kind | Reason | Band | Records |
| --- | --- | --- | --- | --- |
| Granted | `ok` | null | **Access granted** · sub: the zone, plus "until 4:00 PM" when access closes within 12 h | a `scans` row (`zone_id`, `visit`, `access_plan`), the gate row |
| Re-entry wait (opt-in) | `heads_up` | `cooldown` | **Entered 2 min ago** · **Next entry in 8 min.** | heads-up row; **Let in again** per `letInAgain` |
| Denied | `refused` | one of 1.3 | reason copy | refused row |

There is no `already_done` on an access template, ever: SA's `once`/`daily` don't apply (`scanOf` resolves the
access template's `check_in` to `repeat: 'always'`, 7.1 N4). A member who scans five doors in a morning gets five
grants and one visit.

`ScanOutcome` gains `access` (additive, nullable):

```ts
ScanAccessSchema = z.object({
  plan: z.object({ id: z.string(), label: z.string(), kind: z.enum(['always', 'timed', 'guest']) }),
  zone: z.object({ id: IdSchema, name: z.string() }).nullable(),   // the scanner zone that decided; null when the scanner has none
  closesAt: TimestampSchema.nullable(),                          // granted: when this access ends (hours or guest end); null for 24/7
  nextOpenAt: TimestampSchema.nullable(),                        // outside_hours: when it opens next (≤ 7 days), else null
  visits: z.object({ used: z.number().int(), limit: z.number().int().nullable() }).nullable(), // guests, and members for the strip
  visit: z.boolean(),                                            // this grant started a visit
}).nullable()
```

The client picks **Access granted** over **Checked in** when `outcome.access` is set; nothing else in the client
branches on access. `ScanCard.access` carries the same object on `ready` (the desk sees "Opens 8:00 PM" before acting).

### 1.2 Visit counting and the re-entry wait

| Setting (`scan.access.rules`) | Default | Range | Meaning |
| --- | --- | --- | --- |
| `visitGapMinutes` | 120 | 0-720 | grants within this time of the last grant are the same visit. 0: every grant is a visit |
| `reentryMinutes` | null (off) | 1-240 | a grant within this time of the last grant is held: amber `cooldown` |

Why the gap is on and the wait is off: the gap only changes counts, never who gets in, and without it a member who
passes the main door then the pool door counts two visits and a guest with "1 visit" can't reach the pool. The wait
refuses real people, so it must be a choice. Why not anti-passback: it needs an `out` read at every exit, and the
commonest setup (one phone at the front desk) has none. A gym that has exit readers can use a re-entry event (SA
direction `out`) later; not this wave.

### 1.3 Outcomes, reasons and copy

Order is 3.4. Copy goes in `SCAN_REASON_COPY` (`src/shared/copy/scan.ts`); placeholders filled by the client from
`outcome.access`, `outcome.at` and the card.

| Reason | Kind | Headline | Sub | Overridable (Manager) | Beat |
| --- | --- | --- | --- | --- | --- |
| (granted) | ok | **Access granted** | `{zone}` · or `{zone} · until {time}` · or none | — | `gate` |
| `zone_not_included` (new) | refused | **Not in plan** | **{plan} doesn't include {zone}.** | yes | shake |
| `outside_hours` (new) | refused | **Outside hours** | **{plan} opens {when}.** (`when`: "8:00 PM", "Sat 8:00 AM"; none in 7 days: **{plan} has no hours this week.**) | yes | shake |
| `not_yet_valid` (existing, refused here) | refused | **Not open yet** | **Opens {time}.** (existing copy) | yes | shake |
| `guest_expired` (new) | refused | **Guest pass ended** | **Ended {time}.** | yes | shake, gold pass droops (`expired` state) |
| `guest_visits_used` (new) | refused | **No visits left** | **Used {limit} of {limit}.** | yes | shake |
| `suspended` (new) | refused | **Suspended** | **Ask them to see the front desk.** | no | shake |
| `voided`, `removed`, `expired` | refused | existing | existing | no | shake (expired droops) |
| `test_pass`, `live_pass` | refused | existing, no card | existing | no | shake |
| `cooldown` (re-entry wait) | heads_up | **Entered {ago}** | **Next entry in {wait}.** | per `letInAgain` | wrist |

- `not_yet_valid` is amber on tickets (SA) and red on access cards: a member card that starts on the 1st must not open
  the door on the 30th by default. The kind on the wire is what the client paints; the reason keeps its copy.
- `expired` on a guest plan is reported as `guest_expired` (the guest end is also the pass's `expirationDate`, so
  `validityOf` sees it first at SA step 10).
- `suspended` keeps the pass valid in Wallet (no void, no grey card) while the membership is on hold. It comes from an
  input rule (`scan.access.suspend`), so the holder's pass flips back when the input does. A voided pass stays `voided`.
- `notes.refused` (the template's) and the event note follow as today. The blueprint's: **Ask at the front desk.**

### 1.4 Visit history

- `scans` gains `zone_id`, `visit` (1 when the grant started a visit) and `access_plan` (the plan id then).
- For templates with `scan.access`, DM's `history.visits.*` and `history.lastVisit.*` count rows with `visit = 1`
  (same statements, one extra predicate; `scans_pass_ok` still serves them). `history.lastVisit.where` is the zone
  name when the row has one, else the scanner's name.
- New binding root `access` in the display scope (DM §3.1, additive): `access.plan` (label), `access.kind`,
  `access.zone` (name), `access.closesAt`, `access.nextOpenAt`, `access.until` (pass end, ms), `access.visits.used`,
  `.limit`, `.left`, `access.hours` (the plan's hours text, "Mon–Fri 6 AM–4 PM, 8 PM–11 PM · Sat–Sun 8 AM–8 PM").
- Bindings the blueprint uses: `{{history.visits.month}}` ("9 visits", zero form "First visit"), `{{history.lastVisit.at|ago}}`.
- Monitors (ST §3.5) get `zone` on each row; customer screens get the zone as the band sub and up to two system lines
  (ST §3.3 `lines`): **Until 9:00 PM today** when `closesAt` is today, **2 of 5 visits left** for limited guests.

---

## 2. Access types and plans

### 2.1 Where they live: template plans, per-pass choices

| Option | For | Against |
| --- | --- | --- |
| Per-pass hours and zones | any combination | 500 members with hand-typed hours; a change to Off-peak means editing every pass; easy to get wrong at the desk |
| **Template plans + per-pass choices (chosen)** | a gym sells 3-6 plans; changing Off-peak once applies at the next scan; the desk picks from a list; the scanner chip says the plan's name | a one-off needs a plan or an add-on zone |

Per pass stays only what is per person: which plan, extra zones (a pool add-on), the start and end, the guest's
visit limit and sponsor. A one-off arrangement ("Sam may use the studio on Tuesdays") is a plan; plans are cheap.

**Which version decides.** The scanner reads plans from the template's **active** version (like the display, SA D25),
so rule changes apply at the next scan. The pass face shows the plan label and hours through `access.*` bindings;
`template_versions.build_key` includes `scan.access` only when a binding reads `{{access.…}}` (the blueprint does;
Henry's adoption, 4.8, doesn't), so a plan edit reissues faces through the existing stale job and nothing else.

### 2.2 The manifest block

```ts
// src/passkit/types.ts (ScanManifest gains access?: AccessManifest)
type Day = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
type WeeklyHours = Partial<Record<Day, string[]>>;     // "HH:MM-HH:MM", 1-4 per day; end ≤ start runs past midnight;
                                                       // "24:00" only as an end; "00:00-24:00" = all day
interface AccessGrant {
  zone: string | { input: string };                    // a zone key, "*" (every zone), or an input holding a key
  hours?: WeeklyHours;                                 // narrows the plan's hours for this zone ("Pool 6-10")
}
interface AccessPlan {
  id: string;                                          // ^[a-z][a-z0-9_]{0,31}$; passes store it
  label: string;                                       // 1-24: "24/7 Gold", "Off-peak", "Guest day"
  kind: 'always' | 'timed' | 'guest';
  hours?: WeeklyHours;                                 // timed: required; guest: optional; always: none
  zones: AccessGrant[];                                // 1-24
  visits?: number;                                     // guest: default limit, 1-999; none = unlimited in the window
  days?: number;                                       // guest: length when the pass has no end, 1-366 (default 1:
                                                       // until local midnight of the start day)
}
interface AccessManifest {
  input: { plan: string; zones?: string; from?: string; until?: string; visits?: string; sponsor?: string };
  plans: AccessPlan[];                                 // 1-12
  suspend?: { input: string; equals: string[] };       // e.g. status ∈ ["Suspended"]
  rules?: { visitGapMinutes?: number; reentryMinutes?: number | null };
}
```

`input.plan` names a string input whose value is a plan id; the designer gives it `x-widget: "access-plan"` (a select
of the plans with their summaries). `input.zones` names an array-of-keys input (`x-widget: "access-zones"`) or a
string input holding one key (Henry's `homeClub`).

### 2.3 Access types

| Type | Plan | Per pass | Ends |
| --- | --- | --- | --- |
| **24/7** | `kind: always`, zones | plan, add-on zones, start, end (optional) | the end, if any |
| **Timed** | `kind: timed`, weekly `hours`, zones each with optional narrower hours | same | same |
| **Guest** | `kind: guest`, optional hours, default `visits`, default `days` | start (default: issue time), end (default: start day + `days`, at local midnight), visit limit, sponsor (optional, free text ≤ 80, "Guest of") | the end; the visits |

Guest end with no input: `guestUntil` = midnight after the start day + `days − 1`, in the org's time zone
(`access-eval.mjs` `endOfDay`), computed the same way at build (the face's **Until**, `expirationDate`) and at scan.

Sponsor is text, not a link to the member's pass, in v1: a link needs a pass picker, permissions on another holder's
data and a cascade when the member leaves. The display shows **Guest of Maya Okafor** to Desk and up (`x-scan: desk`
on the input); the scans log carries it. Linking guests to members (and capping guests per member) is later.

### 2.4 Validation

Manifest (`accessIssues(manifest, { zones? })`, one call in `validateManifest`; errors block save and upload):

| Code | When |
| --- | --- |
| `ACCESS_SHAPE` | not the shape above (zod, strict) |
| `ACCESS_NO_CHECK_IN` | no `check_in` action |
| `ACCESS_PLAN_ID`, `ACCESS_PLAN_DUPLICATE`, `ACCESS_PLAN_LABEL` | bad or repeated id; label empty, over 24 or repeated |
| `ACCESS_PLAN_DEFAULT` | the plan input's `default` isn't a plan id |
| `ACCESS_INPUT` | an `input.*` name is missing or has the wrong type (plan: string; zones: array of strings or string; from/until: `date-time`; visits: integer; sponsor: string) |
| `ACCESS_HOURS_MISSING`, `ACCESS_HOURS_NOT_ALLOWED` | timed without hours; hours on `always` |
| `ACCESS_HOURS_SPAN` | not `HH:MM-HH:MM`, start = end, `24:00` as a start, more than 4 spans a day |
| `ACCESS_HOURS_OVERLAP` | two spans overlap on one day, counting yesterday's overnight spill |
| `ACCESS_HOURS_EMPTY` | a timed plan or a grant with no open minute in the week |
| `ACCESS_ZONES_EMPTY`, `ACCESS_ZONE_KEY` | no grants; a key not `^[a-z0-9][a-z0-9-]{0,39}$` and not `*` |
| `ACCESS_GUEST_RANGE` | `visits` outside 1-999, `days` outside 1-366, either on a non-guest plan |
| `ACCESS_RULES_RANGE` | rules outside 1.2's ranges |
| `ACCESS_PLAN_IN_USE` (save only) | a plan removed while live or test passes still reference it ("{n} passes use Off-peak. Move them first.") |

Warnings: `ACCESS_ZONE_UNKNOWN` (a key that isn't one of the org's zones; the template may predate them),
`SCAN_CODE_NOT_IN_BARCODE` (existing, now also for access templates), `NFC_STYLE` (existing; generic, see 4.1).

Pass inputs (passes service, on create, update and bulk; 422 problem+json with the field path):
`ACCESS_PLAN_UNKNOWN` (not a plan of the active version), `ACCESS_ZONE_UNKNOWN` (an add-on key not an active zone of
the org), `ACCESS_WINDOW` (end ≤ start), `ACCESS_VISITS` (a visit limit on a non-guest plan).

### 2.5 Time zones and DST

- **Which clock.** A zone's time zone is its nearest ancestor's `time_zone` (only roots set one: a site), else
  `orgs.time_zone` (new, set in org settings, default from the creating admin's browser), else the scanner's. A
  multi-site org in two time zones gives each site root its own.
- **Spans are wall clock.** `06:00-10:00` means 6 to 10 on the local clock every day of the year. Evaluation converts
  the instant to local parts with `Intl.DateTimeFormat(…, { timeZone })` (no tz data shipped), so a change of rules
  in the IANA database follows the runtime.
- **Spring forward** (local 02:00 → 03:00): a span starting inside the gap opens at the gap's end; a span entirely
  inside it doesn't open that day; `nextOpen` and `closesAt` return real instants.
- **Fall back** (01:00-02:00 twice): the repeated hour is inside a span both times; an ambiguous edge resolves to
  the earlier instant.
- **Overnight spans** (`22:00-02:00`) belong to the day they start; Sunday's spill opens Monday morning.
- End exclusive: open at 06:00, closed at 10:00.
- `nextOpenAt` looks 7 days ahead (8 calendar days of edges); null means "no hours this week".
- Display formatting uses the same zone (DM §1.9 actor time zone = the decided zone's).

### 2.6 Holidays (decided: not in v1)

No closure calendar this wave: a closed building isn't opened by a grant, and staff can't be asked to manage dates
they don't need. Seam: a later `scan_zone_closures (zone_id, date, from, until)` evaluated in step 10d before hours,
answering `outside_hours` with sub **Closed today.** Nothing in this design blocks it.

### 2.7 Suspend

`scan.access.suspend = { input, equals }`. The blueprint's `status` (Active, Suspended) drives it. A connection can
own the input (a billing system sets Suspended); a suspended member's Wallet pass is untouched.

### 2.8 Let in anyway

On `zone_not_included`, `outside_hours`, `not_yet_valid`, `guest_expired` and `guest_visits_used`, when the scanner's
`letInAgain` isn't `never`, the refused card offers **Let in anyway** in the dock, always with a Manager (signed in or
PIN approval; Door and Desk can't). It's an override (`overrideOf` = the refused scan) and records a grant with
`override_of`; a guest override counts as a visit, so `visits.used` can pass the limit and the monitor shows it. SA §2.6's `overrideOf` validation widens
to `refused` rows with these five reasons (SV change, section 6.3).

---

## 3. Zones

### 3.1 Model

| Field | Rules |
| --- | --- |
| `name` | 1-40, unique among the org's active zones (case-insensitive): "Main floor", "Pool", "Studio", "Office L3" |
| `key` | slug made from the name at create (`pool`, `office-l3`), editable until a template uses it, then fixed; unique per org |
| `parent_id` | optional; depth ≤ 4 (root + 3); no cycles; same org |
| `time_zone` | roots only; null = the org's |
| `sort` | order among siblings |
| `archived_at` | archived zones grant nothing; children archive with them; a scanner checking only archived zones answers `zone_not_included` and the console flags it |

Example, Northside Gym: **Capitol Hill** (root, America/Los_Angeles) → Main floor → Studio; Capitol Hill → Pool;
**Queen Anne** (root) → Main floor (`qa-main`).

### 3.2 Grants and hours

- A pass's grants = its plan's `zones` plus its add-on zones (`{ zone: key, addOn: true }`). `*` grants every zone.
- The grant that applies to a scanner zone is the **nearest** of that zone and its ancestors, else `*`. So Off-peak
  `[{ zone: 'capitol-hill' }, { zone: 'pool', hours: 6-10 }]` opens the studio in plan hours and the pool 6-10 only.
- Hours that apply = plan hours (none for `always`) ∩ the grant's hours. Add-on zones follow plan hours only (a
  24/7 member's pool add-on is 24/7).
- Guests with hours: plan hours ∩ grant hours, inside the guest window.

### 3.3 Scanners

- `scanner_zones` (0-8 per scanner). The console's **Checks** picker; zero shows **Any zone** with the help **Lets in
  anyone with access to any zone.**
- A scanner on an event has no zones (the picker is disabled with **Events check in once. Zones don't apply.**).
- Several zones: OR. The answer names the zone that decided: the first open covered zone in the scanner's order; when
  none is open, the soonest to open (its `nextOpenAt`).
- A scanner with zones accepts templates as today; zones only matter for access templates.
- Monitors (ST) can watch zones; a scan's `zone_id` is the deciding zone, null when the scanner has none.

### 3.4 Evaluation order (SA §2.6, amended)

Steps 1-9 unchanged. For a pass whose template has `scan.access` and a scanner without an event:

| Step | Check | Answer |
| --- | --- | --- |
| 10 | `removed`, `voided`, `expired` (`validityOf`) | refused; on a guest plan `expired` → `guest_expired` |
| 10a | suspend rule | refused `suspended` |
| 10b | `validFrom` (input) > now | refused `not_yet_valid` (`at`) |
| 10c | guest: now ≥ guest end | refused `guest_expired` (`at`) |
| 10d | zones: no scanner zone covered by a grant | refused `zone_not_included` (the first scanner zone, else none) |
| 10e | hours: no covered zone open now | refused `outside_hours` (`nextOpenAt`) |
| 11-12 | `scan.window` and the event window | skipped (access has its own window; no event) |
| 13 | stop flags under `auto` | heads-up `check_required` (unchanged) |
| 14 | action: role, connection ownership | unchanged (`check_in` is Door) |
| 15 | access gate (3.5): re-entry wait, then the guest visit limit | heads-up `cooldown`; refused `guest_visits_used` |
| 16 | effect | `ok`, with `access` |

Steps 10a-10e are `decide()` in `access-eval.mjs` (pure; production `src/passkit/template/access/decide.ts`). Inputs:
the pass's inputs after defaults, its `created_at`, the active version's manifest, the scanner's zone ids, the org's
zones (one cached read per isolate, 60 s, keyed by org and a `zones_rev` counter on `orgs`), the org's time zone,
`ctx.clock.now()`. On `ready` (desk), the same steps run without the gate so the card shows the verdict before an
action.

Unknown plan id at scan (a version removed it despite 2.4): refused `zone_not_included`, logged
`ACCESS_PLAN_UNKNOWN` with ids.

### 3.5 The gate

One `scan_gates` row per pass, `action_id` = the access action, `scope = 'access'`, `kind = 'check_in'`, `state =
'in'`. `count` holds **visits**, not grants. One UPSERT decides, as SA §7.3:

```sql
INSERT INTO scan_gates (pass_id, action_id, scope, org_id, mode, template_id, kind, state, count, first_at, last_at, last_scan_id)
VALUES (:pass, :action, 'access', :org, :mode, :tpl, 'check_in', 'in', 1, :now, :now, :scan)
ON CONFLICT (pass_id, action_id, scope) DO UPDATE SET
  prev_state = state, prev_last_at = last_at, prev_scan_id = last_scan_id,
  count = count + (CASE WHEN :now - last_at > :gapMs OR :gapMs = 0 THEN 1 ELSE 0 END),
  last_at = :now, last_scan_id = :scan
WHERE (:waitMs IS NULL OR :override = 1 OR :now - last_at >= :waitMs)
  AND (:limit IS NULL OR :override = 1 OR NOT ((:now - last_at > :gapMs OR :gapMs = 0) AND count >= :limit))
RETURNING last_scan_id, count, prev_last_at;
```

- Won: the scan finalizes `ok` with `visit = (prev_last_at IS NULL OR now − prev_last_at > gap)`, in the check-in
  fast-path batch (SA §7.3), so the row, gate and ledger commit together.
- Lost: one read of the row says which: within the wait → heads-up `cooldown` (`cooldownRemainingMs`), else refused
  `guest_visits_used`.
- Undo of a grant restores `prev_*` (SA release rule) and decrements `count` when the undone scan had `visit = 1`.
- A new guest window (an edited `validFrom`) doesn't reset visits; **Reset visits** in the pass's Access card does
  (Manager-only console action, audited `pass.access_visits_reset`, deletes the gate row).
- `visits.used` for the outcome is the returned `count`.
- Checked in SQLite 3 against the 0001-0016 + 0014 + 0020 schema: limit 2, gap 2 h: grants at 0 and 0:30 (one visit),
  5:00 (two), 5:30 (same visit), 9:00 refused, 9:00 with override won (three), a 10-minute wait refused at 9:01.

### 3.6 Admin UX

Mockups in `access/admin/` (section 9). All platform-admin, SD §10 patterns, terse copy.

**Scanning tabs** become **Devices · Events · Zones · Staff · Scans** (ST renames Scanners to Devices).

**Zones tab** (`/admin/scanning?tab=zones`):
- `PageHeader` **Zones**, primary **New zone**. Empty state: buddy `wave`, **No zones yet.** · **Zones let a pass
  open some doors and not others.** · **New zone**.
- Tree list, roots first: Name (indented, `CornerDownRight` under a parent) · Key (mono, muted) · Time zone (roots;
  children show it muted) · Checked by (**2 scanners** link, or **—**) · Plans (**Off-peak, 24/7 Gold** across
  templates) · menu (**Edit**, **Add a zone inside**, **Archive**). Archived behind **Show archived (n)**.
- **New zone** (`sm`): **Name** · **Inside** (none, or a zone; depth-limited) · **Time zone** (roots only; default the
  org's; help **Hours at this site use this clock.**). Footer **Cancel** · **Create**.
- **Archive Pool?** · **Its doors stop letting anyone in. 2 scanners check it; 3 plans grant it.** · **Archive**
  (danger). **Restore** brings it and its children back.
- Mobile (390): the tree becomes a list with indentation by level (16 px per level), the row's secondary line is
  "Key · 2 scanners", menu trailing.

**Devices (scanner) dialog and detail**: **Checks** zone multi-picker (chips with the tree in a popover, ≤ 8),
**Any zone** when empty. Detail aside: **Checks Pool** and the plans that open it now (**Open now for: 24/7 Gold,
Off-peak**), so staff can see why a member is refused.

**Org settings**: **Time zone** (combobox of IANA zones, default from the browser). Changing it says **Hours at sites
without their own time zone move to this clock.**

**Template designer, Access section** (outline: … Inputs · Barcode · Scanning · **Access** · NFC):
- Off by default for non-blueprint templates: **Use as an access card** (switch) adds the block, the plan, zones,
  start, end, visits, sponsor and status inputs, and the check-in action.
- **Plans** list (drag to reorder, 1-12): label · type pill (**24/7** `Infinity`, **Timed** `Clock`, **Guest**
  `Ticket`) · summary (**Mon–Fri 6 AM–4 PM, 8 PM–11 PM · Sat–Sun 8 AM–8 PM**, **All zones**, **Pool 6–10 AM**) ·
  passes using it (**128 passes**). **Add plan**.
- Plan inspector: **Name** · **Type** (three `OptionTile`s: **24/7** *Any time.* · **Timed** *Set weekly hours.* ·
  **Guest** *A day or a few, with an optional visit limit.*) · **Hours** (timed; guest optional) as a week grid: a row
  per day with span chips, **Add hours**, a day toggle **Closed**, and **Copy Monday to weekdays**; spans past
  midnight read **10 PM – 2 AM (next day)** · **Zones**: **All zones** or a zone picker; each picked zone has **Limit
  hours** (its own week grid, shown narrowed: anything outside the plan's hours is struck and labelled **Outside the
  plan**) · Guest: **Lasts** (days, default 1, help **Ends at midnight.**), **Visit limit** (optional).
- **Rules**: **Count as one visit within** (minutes, default 120) · **Wait between entries** (off, or minutes) ·
  **Suspend when** {input} is {values}.
- **On the scanner** strip: the chip and the band as staff will see them (inert).
- Issues use 2.4's codes with copy such as **Off-peak: hours overlap on Monday.**, **Off-peak has no zones.**,
  **{n} passes use Off-peak. Move them first.**, **Pool isn't a zone of Northside Gym yet.** (warning) with **Create
  zone**.

**Pass form** (create, edit, bulk): the **Access** group renders by widget:
- **Plan** select (`access-plan`): label and summary per option; guest plans reveal the **Guest** group.
- **Extra zones** (`access-zones`): zone picker; help **On top of the plan's zones, in the plan's hours.**
- **Starts** (none = **Now**) · **Valid until** (none = **No end**; guest default shown as placeholder **Ends at
  midnight**).
- **Guest**: **Visit limit** (placeholder the plan's default), **Guest of**.
- **Photo**: the existing per-pass thumbnail upload, labelled **Photo** with help **Shown to staff at the door.**
- Pass detail gets an **Access** card: plan, zones as chips, **Open now** / **Opens Sat 8:00 AM**, visits this month,
  last visit (zone · time), and **Reset visits** (guests).

**Accessibility**: the week grid is a table with a row header per day; spans are buttons ("Monday, 6 AM to 4 PM,
edit"); adding a span opens two time fields (`DateTimeField` time mode) with typed entry; overlaps announce in the
field error. The tree list uses `aria-level`. All targets ≥ 44 on touch, AA in both themes (the kit's tokens).

---

## 4. The Access card blueprint

Package `templates/starter-access-card/` (the `starter-*` slug rule, TI §6.4); the draft is in
`access/pass/starter-access-card/`. Gallery position: after Membership card (`Membership, Access, Poster, Balance,
Stamp, Coupon, Event, Boarding`).

### 4.1 Style: generic

| | generic (chosen) | storeCard |
| --- | --- | --- |
| Photo on the face | yes: the thumbnail is the member photo | no thumbnail slot |
| Header field for the plan | yes | yes |
| Confusable with | Membership card (different hue, photo, plan in the header) | Balance and Stamp cards (TI wants those two distinct) |
| NFC (VAS) | SA warns `NFC_STYLE` [U: Apple's rule for generic] | supported |

Door access is mostly a staff glance plus a scan: the face photo serves both. NFC is off until Apple approves anyway
(SA D15); if Apple's answer is storeCard-only, an **Access card · tap** variant is a package change: the semantics
are in `scan.access`, not in the style.

### 4.2 Inputs

| Input | Type | Widget | Notes |
| --- | --- | --- | --- |
| `memberName` | string 1-80 | | required, search |
| `memberId` | string 1-64 | | required, search; `scan.lookup` (typed at the desk), barcode alt text |
| photo | per-pass `thumbnail` asset | upload | not an input (DM §4.2); `display.photo` reads it |
| `plan` | string | `access-plan` | default `all_access` |
| `zones` | string[] ≤ 24 keys | `access-zones` | add-ons |
| `validFrom` | date-time | `datetime`, none = **Now** | |
| `validUntil` | date-time | `datetime`, none = **No end** | |
| `visits` | integer 1-999 | | guest only |
| `sponsor` | string ≤ 80 | | guest only, `x-scan: desk` |
| `status` | Active, Suspended | select | `scan.access.suspend` |
| `message` | string ≤ 256 | textarea | back field, notifies |

Plans as shipped: **24/7** (`all_access`, all zones), **Off-peak** (`off_peak`, Mon–Fri 6 AM–4 PM and 8–11 PM, Sat–Sun
8 AM–8 PM, all zones), **Guest day** (`guest_day`, all zones, ends at midnight, no limit). Rules: gap 120, no wait.

### 4.3 Pass

`generic`; `sharingProhibited: true`; header **Plan** (`{{access.plan}}`, change message **Your plan is now %@.**);
primary **Name**; secondary **Zones** (`{{access.zones}}`: "All zones", or names joined with ", ", ≤ 3 then "+2") and
**Valid until** (date, omitted when none); auxiliary **Member** (`memberId`) and **Hours** (timed: the first line of
the hours text, else omitted); back: **Message**, **Guest of**, **Hours** (full text), **Terms** (**Show this card at
the door. It's for you only.**). Barcode QR `{{pass.scanCode}}`, alt text `{{memberId}}`. `expirationDate` =
`{{access.until}}` when set, so Wallet greys an ended guest pass. `access.*` reaches the build through
`PassScope.access` computed by `accessScope(manifest, inputs, zones, tz, createdAt)` in `passes/builder.ts`, like
`scanCode`. A zone rename reissues the org's access passes that show it (bulk-reissue workflow, scoped by template).

### 4.4 Default `scan.display`

```jsonc
{
  "v": 1,
  "holder": "{{memberName}}",
  "photo": { "minRole": "door" },                       // the ID check is the door's job
  "header": { "chips": [{ "id": "c_plan", "text": "{{access.plan}}", "tone": "violet", "icon": "infinity" }] },
  "variants": [
    { "id": "timed", "name": "Timed", "when": { "path": "access.kind", "eq": "timed" },
      "header": { "chips": [{ "id": "c_timed", "text": "{{access.plan}}", "tone": "teal", "icon": "clock" }] } },
    { "id": "guest", "name": "Guest", "when": { "path": "access.kind", "eq": "guest" },
      "header": { "chips": [{ "id": "c_guest", "text": "{{access.plan}}", "tone": "gold", "icon": "ticket" }] } }
  ],
  "panels": [{
    "id": "p_visits", "preset": { "id": "membership", "v": 1 }, "title": "Visits", "icon": "door-open",
    "rows": [
      { "id": "r_member", "type": "columns", "when": { "not": { "path": "access.kind", "eq": "guest" } }, "items": [
        { "id": "i_month", "label": "This month", "value": { "count": "{{history.visits.month}}", "one": "# visit", "other": "# visits", "zero": "First visit" } },
        { "id": "i_last", "label": "Last visit", "value": "{{history.lastVisit.at|ago}}" } ] },
      { "id": "r_guest", "type": "columns", "when": { "path": "access.kind", "eq": "guest" }, "items": [
        { "id": "i_left", "label": "Visits left", "value": "{{access.visits.left}} of {{access.visits.limit}}" },
        { "id": "i_until", "label": "Until", "value": "{{access.until|time}}" } ] },
      { "id": "r_sponsor", "type": "field", "label": "Guest of", "value": "{{inputs.sponsor}}", "whenEmpty": "hide", "minRole": "desk" }
    ] }],
  "notes": { "refused": "Ask at the front desk." },
  "customer": { "chips": ["c_plan", "c_timed", "c_guest"], "panel": null }   // ST §3.1 as amended in §8
}
```

- Ids are unique in the doc (DM §7), so each header's plan chip has its own id. A variant's chips replace the base
  header's, so exactly one plan chip renders, and the customer block names all three (§8).
- Band: system **Access granted** with the zone as the sub (no custom title: the zone is the content). Identity row:
  96 px photo, holder line, meta = the pass subtitle (`{{access.plan}}` from `display.subtitle`, or the member-since
  date when an org adds it), the plan chip.
- Density on `ok`: photo 1 + panel frame 1 + one `columns` row 1 (+ the sponsor field 1 on desk) = 3-4 of 6. A guest
  with no limit hides "Visits left" by strict interpolation (empty `limit`) and shows only **Until**.
- The guest `columns` reads **Visits left 2 of 5 · Until 9:00 PM**.
- Needs `infinity` and `clock` in `SCAN_ICONS` (P0 amendment N6).
- `check-package.mjs` parses this doc with P0's frozen schema (passes today with the two N6 icons swapped and the
  `customer` key removed until A7 lands) and lints the rest: unique ids, the customer chips exist, have no `minRole`,
  and at most 2 come from one header.

### 4.5 Identity (TI §1 system)

| Blueprint | Slug | Style | Hue | `backgroundColor` | `foregroundColor` | `labelColor` | Text | Labels |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Access card | `starter-access-card` | generic | Cobalt | `rgb(29,58,186)` #1D3ABA | `rgb(255,255,255)` | `rgb(207,224,255)` #CFE0FF | 8.9 | 6.7 |

- OKLCH 0.42 / 0.20 / 266: the family's only saturated blue. Nearest neighbour Sky (Boarding pass, hue 250, chroma
  0.12, ΔE_ok 0.095), told apart by chroma and the boarding pass's route footer; Ink (Membership) is near-black.
- `name` **Access card**, `description` **Door access by plan and zone, with a photo for ID checks.**,
  `display.icon` `key` (Key).
- Art: thumbnail 90 × 90, cobalt with three nested door arches stroked teal, violet and gold (the foil) on a pale
  threshold line, read as "doors opening"; replaced per pass by the member photo. `icon` 38 × 38: the org mark on
  cobalt; `logo` 50 × 50 white mark. Painter `accessThumb()` joins `templates/_tools/painters.ts`; drafts in
  `access/pass/art/*.svg`.

### 4.6 The buddy

**`gate`** (new green beat, granted). Happy. No props (moves the gold pass: 0 nodes). Chirp `ok`. 150-700 ms as every
beat (BM §6):

| T0 + ms | Motion |
| --- | --- |
| 150-230 | Anticipation: body squash 1.04 × .96; the gold pass tips down to horizontal across the pocket (the barrier arm, rotate to −90° about its lower corner) |
| 230-390 | The arm lifts: gold pass swings up to +12° past vertical (`--wl-ease-bounce`); the trunk leans 3° toward the door side; eyes look up-left 1.2 |
| 390-520 | Wave-through: the arm dips to 0° and back to +8° once (the "go on" wave); happy arcs widen 1.15 × 1.25 |
| 520-640 | The arm settles to its rest angle; the trunk returns |
| 640-700 | Rest; happy arcs |

Snap at cut: ≤ 2 units. Reduced motion: the end pose (arm up at +8°, happy). `beat-map.ts`: `access granted` → green,
happy, `gate`, `ok`. Re-entry within the gap (no new visit) plays `gate` too: the same "come in".

Denied: the existing **`shake`** (M12) for every red access reason; `guest_expired` also sets the `expired` state
(the gold pass greys and droops), the one-meaning prop. Amber `cooldown`: `wrist`. Customer screens never see the
shake (ST §3.4: `sorry`).

### 4.7 Copy on the gallery card

**Access card** · **Door access by plan and zone, with a photo for ID checks.** Use blueprint copies the plans; the
designer opens the Access section with a callout **Add zones in Scanning, then pick them per plan.** · **Zones**.

### 4.8 Henry's later (no change now)

Henry's Blue and Copper keep their inputs (`homeClub` enum capitol-hill/queen-anne, `access` home/all, `status`
Active/Suspended/Expired/Cancelled). Adoption is one template version each, adding only a `scan` block:

```jsonc
"scan": {
  "actions": [{ "id": "enter", "label": "Let in", "kind": "check_in" }],
  "lookup": { "input": "memberId" },
  "access": {
    "input": { "plan": "access" },
    "suspend": { "input": "status", "equals": ["Suspended", "Cancelled"] },
    "plans": [
      { "id": "home", "label": "Home club", "kind": "always", "zones": [{ "zone": { "input": "homeClub" } }] },
      { "id": "all", "label": "All clubs", "kind": "always", "zones": [{ "zone": "*" }] }
    ]
  }
}
```

Prerequisites: Henry's org creates root zones with keys `capitol-hill` and `queen-anne` (America/Los_Angeles) and
assigns its door scanners. No binding reads `access.*`, so `build_key` doesn't change and no pass reissues (2.1).
Their `expirationDate` and `voided` already map to `expired` and `voided`. Done by the template owner when Henry's
starts scanning; nothing in `templates/henrys-*` changes in this wave.

---

## 5. Events and access

| | Event check-in | Access |
| --- | --- | --- |
| Times | once per event (re-entry by direction) | unlimited |
| Repeat answer | amber **Already checked in** | **Access granted** again |
| Window | the event's | the plan's hours and the pass's start/end |
| Counting | arrived of expected | visits |

**Decided: one scanner can do both, per template.** The deciding fact is the scanner's accept list:

- **Templates scanner** (most gyms): an access template grants; a ticket or class template on the same scanner checks
  in once (its own `repeat`). The front desk scans members and tonight's class tickets without switching.
- **Event scanner**: every template is checked in once per event, access cards included (a members-only night uses the
  member card as the ticket). Steps 10a-10c still run (suspended, not started, guest ended refuse); zones, hours, the
  visit gate and the access action's `repeat: always` don't. The outcome is **Checked in**, not Access granted.
- No mixed meaning per pass: a pass's meaning comes from (template, scanner kind), never from staff choice, so the
  same pass gets the same answer at the same door.

---

## 6. Data, contracts, layout, tests

### 6.1 `migrations/0020_scan_access.sql`

Additive. Independent of `0019` (ST) and `0018` (PT). Touches no rebuild.

```sql
-- Access cards: zones, scanner zones, the org's time zone, and zone and visit on scans.

CREATE TABLE scan_zones (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 40 AND key NOT GLOB '*[^a-z0-9-]*' AND substr(key, 1, 1) GLOB '[a-z0-9]'),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  parent_id TEXT REFERENCES scan_zones (id) ON DELETE CASCADE,
  time_zone TEXT,                  -- roots only (service rule); null = the org's
  sort INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  CHECK (parent_id IS NULL OR time_zone IS NULL)
);
CREATE UNIQUE INDEX scan_zones_org_key ON scan_zones (org_id, key);
CREATE UNIQUE INDEX scan_zones_org_name ON scan_zones (org_id, name COLLATE NOCASE) WHERE archived_at IS NULL;
CREATE INDEX scan_zones_parent ON scan_zones (parent_id);
CREATE INDEX scan_zones_created_by ON scan_zones (created_by);

CREATE TABLE scanner_zones (
  scanner_id TEXT NOT NULL REFERENCES scanners (id) ON DELETE CASCADE,
  zone_id TEXT NOT NULL REFERENCES scan_zones (id) ON DELETE CASCADE,
  sort INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scanner_id, zone_id)
) WITHOUT ROWID;
CREATE INDEX scanner_zones_zone ON scanner_zones (zone_id);

ALTER TABLE orgs ADD COLUMN time_zone TEXT;                         -- IANA; null until set
ALTER TABLE orgs ADD COLUMN zones_rev INTEGER NOT NULL DEFAULT 0;   -- bumped on every zone write; isolate cache key

-- The deciding zone, whether the grant started a visit, and the plan then. Not foreign keys (SA 6.1: proof outlives config).
ALTER TABLE scans ADD COLUMN zone_id TEXT;
ALTER TABLE scans ADD COLUMN visit INTEGER CHECK (visit IS NULL OR visit IN (0, 1));
ALTER TABLE scans ADD COLUMN access_plan TEXT;
CREATE INDEX scans_zone ON scans (zone_id, at DESC) WHERE zone_id IS NOT NULL;
```

- Depth and cycles are service rules (`ZONE_DEPTH`, `ZONE_CYCLE`); the org of a parent and of a scanner's zones is
  checked in the service (`ZONE_ORG_MISMATCH`, 404 body).
- `scan_gates` needs no change: scope `access` is a value.
- `test/migrations.test.ts` `describe('0020_scan_access')`: tables, columns, the FK-child index test, the key CHECK
  (`Pool`, `a b`, `*` rejected), a child with a time zone rejected, cascade from orgs and scanners.
  `test/query-plans.test.ts`: zones by org (tree), scanner zones, `scans_zone` for the monitor snapshot and the Scans
  log filter, visits this month with `visit = 1` on `scans_pass_ok`.
- Retention: nothing new.

### 6.2 Contracts

| File | Names |
| --- | --- |
| `src/shared/contracts/access.ts` (new, AX) | `ZoneKeySchema`, `WeeklyHoursSchema`, `ScanZoneSchema` (`{ id, orgId, key, name, parentId, timeZone, effectiveTimeZone, sort, depth, scanners: int, plans: { templateId, templateName, planId, label }[], archivedAt }`), `CreateScanZoneSchema`, `UpdateScanZoneSchema`, `ScanZoneListQuerySchema` (`orgId`, `archived?`), `ScannerZonesSchema` (`{ zoneIds ≤ 8 }`), `PassAccessSchema` (pass detail card: plan, zones, `openNow`, `nextOpenAt`, visits, last visit), `ScanAccessSchema` (1.1) |
| `src/shared/contracts/scan.ts` | `ScanReasonSchema` + 5 reasons (P0, N1); `ScanOutcome.access`, `ScanCard.access` (`ScanAccessSchema.nullable().default(null)`, N2) |
| `src/shared/contracts/scanners.ts` | `ScannerSchema.zones: { id, name }[]`, `CreateScannerSchema.zoneIds?`, `UpdateScannerSchema.zoneIds?`; `ScanRecordSchema.zone`, `.visit`; `ScanListQuerySchema.zoneId` (later, additive) |
| `src/shared/contracts/orgs.ts` (g) | `OrgSchema.timeZone`, `UpdateOrgSchema.timeZone` (`TimeZoneSchema`) |
| `src/shared/contracts/passes.ts` (d) | `PassDetail.access: PassAccessSchema \| null` |
| `src/shared/copy/scan.ts` | N1 rows; `ACCESS_GRANTED` headline for the client (N3) |
| `src/passkit/types.ts` | `AccessManifest` and friends (2.2), `ScanManifest.access?` (N4) |

Routes (`modules/scan/routes-zones.ts`, `requireAdmin`, mode-free, CSRF, audited `scan_zone.create|update|archive|restore`):

| Method and path | Notes |
| --- | --- |
| `GET`, `POST /api/v1/scan-zones` | list (tree order) and create |
| `PATCH /api/v1/scan-zones/{id}` | name, key (while unused), parent, time zone, sort |
| `POST /api/v1/scan-zones/{id}/archive`, `/restore` | children follow |
| `PATCH /api/v1/scanners/{id}` (existing) | `zoneIds` |
| `POST /api/v1/passes/{id}/access/reset-visits` | Manager-equivalent: admin; audited |

### 6.3 Module layout and ownership (stream **AX**)

| Path | What |
| --- | --- |
| `src/passkit/template/access/hours.ts` | `parseSpan`, `wall`, `instantOf`, `isOpen`, `nextOpen`, `closesAt`, `endOfDay` |
| `.../access/decide.ts` | `resolveGrants`, `grantFor`, `tzOf`, `guestUntil`, `decide`, `suspended`, `visitLimit` |
| `.../access/scope.ts` | `accessScope` (build and display), `hoursText`, `zonesText` |
| `.../access/validate.ts` | `accessIssues` (2.4) |
| `.../access/index.ts` | exports; no imports from `src/worker` or `src/web` |
| `src/worker/modules/scan/access.ts` | `accessCheck(ctx, actor, pass, manifest)` → steps 10a-10e; `accessGateStatement(...)`; called from SV's `resolve.ts`/`act.ts` (one import, SV adds the call) |
| `src/worker/modules/scan/{zones,routes-zones,repo-zones,repo-access}.ts` | zone service, routes, SQL, the cached org zones read |
| `src/web/admin/scanning/zones/**`, `src/web/routes/admin/scanning/` tab entry | Zones tab (AD hosts the tab; AX owns the folder) |
| `src/web/admin/templates/designer/access/**` | Access section (TD hosts the outline entry) |
| `src/web/admin/passes/inputs/{access-plan,access-zones}.tsx` | the two widgets (i registers them) |

Shared touches, each small and reported: SV `resolve.ts`/`act.ts` (the call), `rules.ts` (`overrideOf` widening,
2.8); DS `repo-history.ts` (`visit = 1` predicate), `scope.ts` (`access` root); PT `passes/builder.ts`
(`PassScope.access`), `templates/persist.ts` (build_key rule), `passes/service.ts` (input validation); BU
`beat-map.ts` + the `gate` beat; ST `rows.ts` (`zone` on monitor rows), customer lines; g `orgs` time zone field;
a2 `validateManifest` (one call), `templates/starter-access-card/**`, `_tools/painters.ts`.

### 6.4 Tests

**Pure (`access/*.test.ts`; the reference suite in `access-eval.test.mjs` ports 1:1):**
- spans: parse, overnight, `24:00` end only, bad spans; overlap detection including yesterday's spill.
- schedule: weekday window, end exclusive, Sunday into Monday, `closesAt`/`nextOpen` across midnight and the week,
  none within 7 days.
- DST: America/New_York spring gap (a span starting at 02:30 opens 03:00; 06:00-10:00 stays 06:00-10:00), autumn
  repeat open twice, ambiguous edges earlier; Europe/London gap; Asia/Kolkata half-hour offset; Australia/Lord_Howe
  30-minute DST [add]; a zone whose rule changes (snapshot the runtime's `Intl` answer, not a constant) [add].
- zones: parent grants descendants not siblings; nearest grant's hours win (pool 6-10 inside Off-peak); intersection
  never union; add-ons follow plan hours; multi-zone scanner OR with the first open zone named; no scanner zones;
  no org zones with `*`; archived zones and archived ancestors grant nothing; zone time zone over org over scanner.
- guests: not yet valid, ended (exclusive), default end at local midnight across a DST night, `days: 3`.
- gate: re-entry inside the gap is free, the limit stops only a new visit, gap 0, the wait, override skips both.
- validation: every 2.4 code; the blueprint package passes; Henry's adoption block passes.

**Worker (`vitest-pool-workers`, `makeEnv()`):**
- the full order 10-16 with real D1: each reason once, in order (a suspended guest outside hours answers `suspended`).
- multi-zone: a scanner on Pool and Studio; Off-peak at 11 AM grants Studio, refuses Pool alone.
- guest limit under concurrency: two scanners scan a 1-visit guest's pass at once (two inserts racing): one `ok`,
  one `guest_visits_used`; within the gap both `ok` and `count` stays 1.
- undo of a visit decrements; undo of a non-visit grant doesn't.
- isolation: a zone id of org B on org A's scanner → 404 on PATCH; org B's pass at org A's door is `not_found` with
  the body of a random code; a test scanner and a live scanner share zones but never passes; zone names never appear
  in another org's outcome.
- history: visits this month counts visits not grants, in the scanner zone's time zone at a month edge.
- `ready` shows `access` without writing a row or touching the gate.
- event scanner: an access card checks in once, then `already_done`.
- logs: no zone names, inputs or sponsor in log lines (ids only).

**Web:** the week grid (keyboard, overlap error, copy to weekdays), the zone tree (`aria-level`, archive dialog), the
widgets in the pass form, axe at 1440/820/390 in both themes.

**e2e (`e2e/17-scan-access.spec.ts`):** create zones and a scanner on Pool; Use blueprint; issue a 24/7 member, an
Off-peak member and a 2-visit guest; scan at fixed clock times (test clock): granted with **Pool**, outside hours,
not in plan, visits used, suspended after a status change, Let in anyway with a Manager PIN.

---

## 7. Phase 0 amendments

### Now (P0 is mid-build; frozen files only, all additive)

| # | File | Change |
| --- | --- | --- |
| N1 | `src/shared/contracts/scan.ts`, `src/shared/copy/scan.ts` (+ tests) | `SCAN_REFUSED_REASONS` + `zone_not_included`, `outside_hours`, `guest_expired`, `guest_visits_used`, `suspended`, with 1.3's copy. The copy test (every reason has a line) covers them |
| N2 | `src/shared/contracts/scan.ts` | `ScanAccessSchema`; `ScanOutcome.access` and `ScanCard.access`, nullable, default null. Fixtures stay valid |
| N3 | `src/shared/copy/scan.ts` | `SCAN_OK_COPY.access`: **Access granted**; sub patterns `{zone}`, `{zone} · until {time}` |
| N4 | `src/passkit/types.ts`, `src/shared/scan-defaults.ts` (+ test) | `ScanManifest.access?: AccessManifest` (types only); `scanOf` resolves `check_in` to `repeat: 'always'` when `access` is set; `SCAN_SHAPE` accepts the `access` key (validated later by `accessIssues`) |
| N5 | `migrations/0014_scan.sql` | none. Zones arrive in `0020`; nothing in 0014 needs to change shape for them |
| N6 | `src/passkit/template/scan-display/icons.ts` | `SCAN_ICONS` + `infinity` (Infinity), `clock` (Clock3): the blueprint's plan chips |

Plus ST's A7 (`ScanDisplayDoc.customer`), which the blueprint's doc uses, with one change before it lands:
`customer.chips` is `z.array(IdSchema).max(18)` in the schema (≤ 2 per header × base and 8 variants), the per-header
cap is the validator's (§8).

### Later (stream AX, after M1; nothing renames or narrows a frozen contract)

| Milestone | Delivers |
| --- | --- |
| AX.1 (M2) | `0020`, pure `access/**` with the ported suite, `accessIssues`, zone service and routes, scanner zones, org time zone |
| AX.2 (M2) | `accessCheck` and the gate in SV's flow, `overrideOf` widening, history predicate, `access` scope root, `PassScope.access`, build_key rule |
| AX.3 (M3) | Zones tab, scanner Checks picker, Access designer section, pass widgets and detail card |
| AX.4 (M3) | The blueprint package and art, `gate` beat (BU), customer lines and monitor zone (ST) |
| AX.5 (M4) | e2e 17, device checks (a gym morning: 200 grants, two doors, a guest) |

---

## 8. With stations (ST)

Accepted from ST: `scans.zone_id` routes monitors (`watch { zoneIds ≤ 8 }`); the customer band reads **Access
granted** with the zone name as the sub; system lines **Until 9:00 PM today** and **2 of 5 visits left** (≤ 40, ≤ 2)
come from `outcome.access`. A pool lifeguard's monitor watching **Pool** sees every grant and refusal at any door
that checks Pool.

Two changes to ST, both small:

| # | ST says | AX needs | Why |
| --- | --- | --- | --- |
| C1 | `customer.chips`: ≤ 2 ids (§3.1, A7) | ≤ 2 ids **from any one header** (base or a variant); schema `max(18)`, `SCAN_DISPLAY_CUSTOMER_DENSITY` checks per header | DM ids are unique in the doc, so a plan chip that changes tone per variant has one id per variant. Only one header renders, so the customer still sees ≤ 2 chips. The blueprint names `c_plan`, `c_timed`, `c_guest` |
| C2 | every refusal is **Please see the desk** with no sub (§3.4) | three refusals add a customer-safe sub: `outside_hours` **Your plan opens at {time}.**, `guest_expired` and `guest_visits_used` **Your guest pass has ended.** Never the zone, the plan's other hours or a suspension | the member can act on it (come back at 4) without staff; the customer mockups already show it |

---

## 9. Mockups

Scanner results (phone 390 × 844 at 3×, iPad 1180 × 820 at 2×, light and dark; `pages/a-*.html`, `shots/a-*.png`,
the mockup stream): granted (Pool, 24/7 Gold, photo, Visits), re-entry inside the gap, timed (until 4:00 PM),
guest (2 of 5, Guest of), not in plan, outside hours, guest ended, visits used, suspended, not yet valid.

Console (`node access/gen/admin.mjs`; pages `access/admin/<id>.html`, shots `access/admin/shots/<id>-<1440|390>-<light|dark>.png`):

| Id | Shows |
| --- | --- |
| `zones` | Scanning › Zones: the tree (roots with a building icon, children indented), key, time zone, checked by, plans; phone list with "key · scanners" |
| `zone-new` | New zone inside Capitol Hill: the inherited time zone is read-only, the key previews |
| `zone-archive` (390) | Archive Pool? with its consequences |
| `plans` | Designer › Access: plan list with type pills and pass counts, the Off-peak inspector (type tiles, week grid, Copy Monday to weekdays, Pool with **Limit hours**), rules, the "On the scanner" strip, the pass preview |
| `hours-edit` (390) | Monday's spans with the overlap error |
| `pass-form` | New pass: Member (photo), Access (plan menu with summaries, extra zones, start, end placeholder **Ends at midnight**), Guest (visit limit, Guest of), Status |
| `pass-detail` | Pass › Access card: plan, zones, open now, visits, last visit, recent grants and a refusal |
| `scanner-zones` | Device dialog: **Checks** with the zone tree popover and **Open now for** |
| `stills` (1440) | `PassCard` stills: the blueprint, Maya (photo), Leo (Off-peak), Sam (Guest day), Priya (office). The identity sheet's stills show the QR (`gen/pc-entry.ts` sets the barcode engine); the console mock hides it |

## 10. For the owner

1. **Generic or storeCard.** Generic gives the photo on the card; if Apple allows VAS NFC only on store cards, door
   taps need the storeCard variant (4.1). Ask Apple with the NFC application? [U]
2. **Not yet valid is red on access cards** (amber on tickets). A Manager can still let them in. Agree?
3. **Visits merge within 2 hours** by default (main door, then pool, is one visit). Different default?
4. **Guests are text-sponsored** ("Guest of Maya Okafor"), not linked to the member's pass, this wave. Later: link,
   and a guests-per-member cap.
5. **No holiday calendar** this wave (2.6).
