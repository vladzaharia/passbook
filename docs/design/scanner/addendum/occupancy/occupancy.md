# Occupancy: in and out, tap-out, capacity and desk overrides

> **Folded 2026-11-05** into SA §20, SD §18, DM §12, BM §6.1 and §6.8, the plan (§5.17, M3B) and P0A; those win.
> Changes made in the fold: Phase 0 takes **P0-9** and **P0-10** only (P0-10 with one default line per reason;
> variants with OC.1); P0-11 to P0-13 land additively in OC.1, and P0-14 becomes a new guard option
> `screenActions?: boolean` (SV.11), so the built `screens?: boolean` keeps its type. UI, monitor, customer and buddy
> work belong to the existing streams (UI.9, MN.2, CD.3, BU.8); stream OC owns the server core, the routes, the
> contract file and the pass's occupancy card; the zone fields are AX's (AX.6). DS adds a `duration` filter for stays.
> The customer screen announces **Tapped out.** without the name (SD §16.6). The `occ-flip` captions call the hub
> message `override`; it is `resolved`.
>
> **Review 2026-11-05, latest** (SA §20 and §2.5-2.6 updated; `gen/occupancy.mjs` and its tests, now 23, match): an
> override waives **one reason at a time** from the actor's rights (`wParent`, `wInside`, `wWait`, `wLimit`, `wCap`;
> `:override` only resets `since`), and every step re-runs at override time; implied ancestors with a capacity are
> counted unless the pass is already in them, and get their own due time; a row past `due_at` reads as out everywhere,
> and any re-entry over an `in` row sends its children out; Track off, archive or a parent change taps the subtree out
> (`out_cause` `zone`); Require tap out needs Max stay or Clear at; undo is all or nothing (one guard) and bumps
> revisions; `scans_override_once` covers pending and winning overrides only; monitors may undo their own scans and
> post the note; the inside list needs Desk actions. Sections 9 and 10 below are superseded by P0A and plan §5.17.
Architecture and product design for the owner's two requests, 2026-11-05. Status: decided, ready to build after
Phase 0 merges (Phase 0 takes P0-9 and P0-10 only; P0A).

> "Can we add occupancy support? Next entry only allowed after a tap out is recorded."
>
> "The desk view should also allow for easy overriding (ie. if no access, or already in, etc) on the fly, which
> would change the state and the screen."

Cited as **SA** `scanner-architecture.md`, **AX** `addendum/access.md`, **ST** `addendum/stations.md`, **RT**
`addendum/cloudflare-realtime.md`, **UX** `addendum/ux.md`, **SD** `scanner-design.md`, **BM** `buddy-motion.md`,
**PL** `scanner-plan.md`, **P0A** `addendum/p0-amendments.md`. Paths in code blocks are repo paths. **[U]** = verify
on a device.

Precedence: this file wins over AX, ST, SA and BM on occupancy, direction, tap-out, capacity on zones and desk
overrides. It **overturns AX X7 and SA D35** ("anti-passback is not offered"), section 0.1. Everything else in those
files stands.

Files here (`addendum/occupancy/`):

| Path | What |
| --- | --- |
| `gen/occupancy.mjs` | Reference: migration `0020` as extended, the pure rules (`placeOf`, `entryPlan`, `dueAt`, `direction`, `entryReason`) and every D1 statement. Spec in code for `modules/scan/occupancy/**` |
| `gen/occupancy.test.mjs` | `node --test gen/occupancy.test.mjs`: 23 cases, all pass. Applies `next/n8-p0`'s 0001-0016 (read-only), P0-9 in memory, then `0020`, on SQLite 3.54 (D1's engine): races, capacity, nesting, auto tap-out, DST, undo, isolation, query plans |
| `gen/{scanner,customer,monitor,console,strips}.mjs`, `gen/occ.css`, `gen/o-kit.mjs` | Mock generators on the addendum kit (read-only imports). `node gen/run.mjs scanner customer monitor console strips`, then `node gen/sheets.mjs` |
| `sheets/occ-*-{light,dark}.png` | Contact sheets (section 8) |
| `shots/*.png`, `gen/pages/*.html` | Every state, light and dark |

Only this file ships. Every row above is **not shipped**: the reference code, its tests, the generators, the sheets and the shots stay in the design folder. The sections that cite them carry the rules in prose and SQL.

Only this file ships. Every row above is **not shipped**: the reference code, its tests, the generators, the sheets and the shots stay in the design folder. The sections that cite them carry the rules in prose and SQL.

---

## 0. Decisions

| # | Decision |
| --- | --- |
| OC1 | **Each pass has an in/out state per place: in or out, since when, through which scanner.** A place is a zone (`zone:<id>`) or an event (`event:<id>`). It lives in `scan_gates` (the scope is the place), so zone occupancy and event re-entry are **one model, one set of statements** (section 2). |
| OC2 | **Turned on per zone, never per plan.** Zone settings: **Track who's inside** (`occupancy: track`), **Require tap out** (`enforce`), **Capacity**, **Max stay**, **Clear at**. Exits are doors and doors belong to zones; a plan can't add an exit reader, and one door must answer everyone the same way. |
| OC3 | **Tracking never refuses anyone except Full. Require tap out is what refuses:** a second entry into a zone the pass is inside answers amber **Already in** (`still_inside`) until a tap-out is recorded. |
| OC4 | **Leaving is never refused for who you are.** A tap-out skips the pass's validity, plan, hours and guest checks (SA steps 10-14): a voided, suspended or ended pass still taps out. Only "not this org's pass" stops it. |
| OC5 | **Nested zones:** entering a zone needs the pass inside the nearest ancestor that requires tap out, and enters every tracked zone between them (implied entry). Leaving a zone leaves every zone below it. So a parent's count already includes everyone in its children. |
| OC6 | **A scanner is In, Out or Both** (`ScannerSettings.direction`, default `in`). It counts in its **first tracked zone** (or its event). Both runs **Auto** on the device (inside → out, outside → in) with a capsule chip; staff can pin In or Out for a rush (lapses after 15 min without a scan). Readers at a door use a fixed direction. |
| OC7 | **Turnaround guard:** on Auto, a pass that changed direction at that place under **2 min** ago isn't flipped back; the scan is held amber with the inferred direction as a one-tap dock action. Double scans never tap anyone out (or back in). |
| OC8 | **Forgotten tap-outs end on their own:** auto tap-out at **Max stay** (default 12 h when tracking turns on) and/or a daily **Clear at** time in the zone's clock, by the minute cron (`scan.occupancy`, 200 rows a run). Staff **Mark as out** from the desk monitor or the console; **Let in anyway** records a forced exit and a new entry. |
| OC9 | **Capacity is exact.** The count condition rides inside the entry statement, so two doors racing the last place get one entry. **Full** is amber `capacity_full` (the pass is fine), override **Manager only**, zones and events alike. |
| OC10 | **Visits count on entry only** (AX's gate, unchanged). The re-entry wait and the guest limit are checked inside the same entry statement, so a refused entry never moves the in/out state and nothing needs undoing. |
| OC11 | **In now is exact and ordered.** Counts come from `scan_gates` in the committing batch with a per-place revision (`scan_place_revs`); the hub forwards them; monitors keep the highest revision. |
| OC12 | **Two new heads-up reasons, `still_inside` and `not_inside`;** `capacity_full` is reused (zones read **{zone} full** as a variant; events keep **Event full**). Exits read **Tapped out** (events keep **Checked out**). |
| OC13 | **Migration: extend `0020_scan_access.sql`** (not built): occupancy columns on `scan_zones`, `scan_gates.due_at`, `scan_place_revs`, `scans.out_cause`, `scans.override_note`, one-override-per-scan index. Phase 0 takes **P0-9**: `scans.actor_type` + `system` and `scans.method` + `auto` (else a `scans` rebuild later). |
| OC14 | **Desk overrides:** a Desk monitor with **Desk actions** on (default off) and a staff member signed in by PIN can **Let in** any soft refusal or in/out hold of a scanner in its watch, one tap, within 15 min, and **Mark as out** anyone inside. Full, guest limits and no-access refusals need a Manager (signed in or PIN). Hard refusals are never overridable. |
| OC15 | **An override changes the state and the screens live:** it records the entry (and the forced exit), the in/out state and the visit, resolves the alert, and the hub flips the refusing scanner (`resolved`, by device) and its customer screen (a body that replaces the same `ref`) to **Access granted**. Buddy: `relent`, a 150 ms "oh" then `gate`. Undo: 8 s toast, 10 min from the row. |

### 0.1 Overturning "no anti-passback" (AX X7, SA D35)

AX rejected anti-passback because the commonest setup (one phone at the front desk) has no exit scans. That reason
still holds for that setup, which is why the result here is **opt-in per zone** with **Track** and **Require tap out**
both off by default. What makes it safe to offer now:
- **Both on Auto** (OC6) gives the one-phone desk exits for free: the same scan taps out.
- **Nobody is locked out for good** (OC8): auto tap-out, Mark as out, Let in anyway.
- **Kind holds, not refusals:** amber, staff-facing, one tap to fix.

The photo stays the main anti-sharing control. AX's re-entry wait (`reentryMinutes`) stays; with Require tap out on, it
is usually unnecessary (the designer says so in its help).

Text to change on fold: AX X7 and §1.2's "Why not anti-passback"; SA D35, §19.4 and §19.9's last bullet; SD §16.3 and
§17 ("no In now for zones"); ux.md §3.2 and §9 item 1; BM §6.1 (`dip` becomes `bye`) and §8's red capacity row (7.5).

---

## 1. Semantics

Words: **occupancy** is who is inside a place; a pass's **in/out state** is its row for one place. SA's
**presence** keeps its meaning (devices online, `LivePresenceSchema`); nothing here is called presence.

### 1.1 The in/out state

| Field | Source |
| --- | --- |
| state | `scan_gates.state` (`in` or `out`) for scope `zone:<id>` or `event:<id>` |
| since | `last_at` (the entry when in, the exit when out) |
| through which scanner | `last_scan_id` → `scans.scanner_id`, `station_id`, `staff_id` |
| due | `due_at`: when the system taps them out (in rows only) |

One row per pass, access action and place (the gate's primary key). A pass with no row is out.

### 1.2 Zone settings (where it's turned on)

| Setting | Values | Default | Meaning |
| --- | --- | --- | --- |
| **Track who's inside** | on/off | off | Count in and out; In now on monitors, the console and the scanner's count chip |
| **Require tap out** | on/off (needs Track) | off | A second entry while inside answers **Already in** |
| **Capacity** | 1-100,000 or none | none | Entries past it answer **{zone} full** |
| **Max stay** | 15 min-48 h or none | 12 h when Track turns on | Anyone inside longer is tapped out |
| **Clear at** | a local time or none | none | Everyone inside is tapped out daily at this time (the zone's clock; needs a time zone on the root or the org) |

Stored as `scan_zones.occupancy ('off' | 'track' | 'enforce')`, `capacity`, `max_stay_minutes`, `clear_at`.

**Why per zone, not per plan (or both):** occupancy is about a door, and a door is shared by every plan. Per plan, the
same door would let Maya in twice and refuse Sam, and staff couldn't predict it; counts would miss the untracked plans;
and a plan can't conjure an exit reader. A plan-level exemption (staff passes) is a Manager override, not a setting.

### 1.3 Entry and exit

| | Entry (direction `in`) | Exit (direction `out`) |
| --- | --- | --- |
| Checks | SA 1-9, AX 10-10e (validity, suspend, start, guest end, zone, hours), 13-14, then the in/out gate (1.6) | SA 1-9 only, then the in/out gate |
| In/out state | out → in (cascade up: implied entries) | in → out (cascade down) |
| Visit | AX's gate: a new visit when more than the gap after the last grant | none |
| Refused | `still_inside`, `not_inside` (parent), `cooldown`, `guest_visits_used`, `capacity_full` | `not_inside` (nothing to close; they still leave) |
| Verdict | **Access granted** (events: **Checked in**) | **Tapped out** (events: **Checked out**) |

Track-only zone, entry while inside: granted; the row keeps its `since`; the visit gap decides the count.

### 1.4 Nested zones

Northside Gym: **Gym** (root, Require tap out, 60) → **Pool** (Track, 25) → **Sauna** (Track, 8); Gym → **Studio**
(off).

- **Entering a child needs the parent:** Pool's nearest enforcing ancestor is Gym, so a Pool entry with no Gym
  entry answers **Not tapped in · Tap in at Gym first.** (`not_inside`). A Manager or the door's `letInAgain` can
  let them in, which enters Gym too.
- **Implied entry:** Sauna's ancestors Pool (track) and Gym (enforce): a Sauna entry needs Gym and enters Pool with it.
  A count-only parent never refuses; it is entered with the child, so a pool with its own street door still counts.
- **Leaving a parent leaves its children:** a tap-out at Gym exit closes Gym, Pool and Sauna in one batch.
- **Counts roll up:** in(child) ⇒ in(every tracked ancestor), kept by the statements, so Gym's In now includes the pool.
  An untracked zone (Studio) has no count.
- Race: a Gym exit and a Pool entry at the same instant end consistent in either order (tested): the Pool entry's
  parent check is inside its statement.

### 1.5 Plans, guests, visits, waits

- **Timed:** hours gate the entry only. Nobody is tapped out when Off-peak ends; Max stay and Clear at cover forgetting.
- **Guest:** visit limit and end gate the entry only. A guest still inside after their pass ends shows **Pass ended** on
  the monitor's inside list; exits always work.
- **Visits** stay AX's: counted on entry, merged within `visitGapMinutes`. In, out, back in within 2 h is one visit; a
  1-visit guest can step out and back.
- **Re-entry wait** (AX, opt-in) still measures from the last entry. Checked inside the entry statement.

### 1.6 Step 15 order on an entry (one fixed order)

`not_inside` (enforcing parent) → `still_inside` (this zone enforces) → `cooldown` (AX wait) → `guest_visits_used`
(AX limit) → `capacity_full`. Who-you-are (10-10e) comes before all of them; the place comes last, so a guest out of
visits is never told to wait for a free place.

### 1.7 Events: one model with zones

An event is a place. SA's check-in with re-entry becomes the occupancy path:

| Event setting | Occupancy | In while in | Out while not in | Capacity |
| --- | --- | --- | --- | --- |
| re-entry off | once (in only; no exits) | `already_done` **Already checked in** (unchanged) | — | exact, `capacity_full` **Event full** |
| re-entry on | enforce | `still_inside` **Already checked in** (same words, new code) | `not_inside` **Not checked in** · **Check them in instead?** | exact |

- Event scanners get the same **Direction** (In, Out, Both/Auto); SD's menu item **Direction: In / Out** becomes the
  capsule chip. One control, one statement builder.
- SA §7.3's `once` + `direction out` rows and §7.4's "capacity is a soft limit" are superseded: capacity is in the entry
  statement, so it is exact for events too.
- Events never auto tap out (the event ends). No zones on event scanners (AX).

---

## 2. Data and concurrency

### 2.1 Why `scan_gates`, not a new table

The gate already is the atomic in/out machine (SA §7.3) with `prev_*` for undo and an index that counts by scope and
state (`scan_gates_count`, covering). Zones and events then share one implementation, one undo, one count query. What
occupancy adds is a due time (one column) and an order for counts (one tiny table). A separate table would duplicate the
gate's transitions, undo and counts for no gain.

### 2.2 Statements (reference: `gen/occupancy.mjs`)

Every entry is one D1 batch (one transaction), as SA's check-in fast path:

```
1 ENTER          upsert the place's in/out row; WHERE enforcing parent in, AX wait and limit, not inside (enforce),
                 count < capacity; one statement, so it either moves or doesn't
2 ENTER_IMPLIED  per tracked ancestor up to the enforcing one: in, if 1 won
3 EXIT_BELOW     children out, if 1 won over a row that was in (forced, past due, track-only repeat)
4 VISIT          AX's gate UPSERT, if 1 won (or no tracked place)
5 REV            per changed place: rev + 1, if 1 won
6 finalize scan  WHERE 1 won (SA fast path); ledger INSERT … SELECT WHERE 1 won
7 COUNTS         In now with revs for the changed places (only when a monitor listens)
```

A loser runs `LOSS_READ` (one statement) and `entryReason()` names the reason by 1.6's order.

Exit: `EXIT` on the place (CAS on `last_scan_id` for the cron), `EXIT_BELOW` for descendants, `REV`, finalize, ledger.

The key condition, excerpt:

```sql
INSERT INTO scan_gates (pass_id, action_id, scope, org_id, mode, template_id, kind, state, count, first_at, last_at, last_scan_id, due_at)
SELECT :pass, :action, :place, :org, :mode, :tpl, 'check_in', 'in', 1, :now, :now, :scan, :due
WHERE <parent in or :wParent> AND <AX wait or :wWait, limit or :wLimit>
  AND (:cap IS NULL OR :wCap = 1 OR <inside(:place)> < :cap) AND <each implied ancestor's capacity or :wCap>
ON CONFLICT (pass_id, action_id, scope) DO UPDATE SET
  prev_state = state, prev_last_at = last_at, prev_scan_id = last_scan_id,
  state = 'in', count = count + (NOT <live in> OR :override = 1),
  last_at = CASE WHEN <live in> AND :override = 0 THEN last_at ELSE :now END,
  last_scan_id = :scan,
  due_at = CASE WHEN <live in> AND :override = 0 THEN due_at ELSE :due END
WHERE <parent in or :wParent> AND <AX wait or :wWait, limit or :wLimit>
  AND (NOT <live in> OR :enforce = 0 OR :wInside = 1)
  AND (state = 'in' OR :cap IS NULL OR :wCap = 1 OR <inside(:place)> < :cap) AND <each implied ancestor's capacity>;
-- <live in> = state = 'in' AND (due_at IS NULL OR due_at > :now): a row past due reads as out before the cron runs.
```

- **Two doors at once:** D1 runs batches one after another; the second sees the first's row (tested: one entry, one
  `still_inside`, one visit).
- **No compensation:** the AX wait and limit are evaluated inside statement 1 (same transaction as statement 4), so a
  refused visit never leaves the in/out state moved.
- **The access action id** keys the row (as AX's visit gate), so there is one row per pass per place.
- **Offline replay (v2, event scanners):** batch items add `AND :clientTs >= last_at` to 1 and `EXIT`; an item older
  than the row's last transition is recorded after the fact as a heads-up with no state change (the Ticketmaster rule,
  SA §9.2).

### 2.3 In now and the hub

- **Exact:** `inside(place)` = `count(*)` over `scan_gates_count` (index-only, tested by query plan) in the committing
  batch. Read only when capacity is set (statement 1) or a monitor listens (statement 7, `actor.live`).
- **Ordered:** `scan_place_revs (org_id, mode, place, rev)` is bumped in the same batch as the change. Every published
  monitor row carries `places: [{ place, inNow, capacity, rev }]` for the places it changed (zone and implied ancestors
  on entry; zone and descendants on exit). The client keeps, per place, the value with the highest `rev`. Publishes
  that reach the hub out of commit order can't roll a count back.
- **Snapshot:** `GET /scan/live/snapshot` returns `counts.places` (count + rev per watched place) from the same tables.
- **The hub stays a router** (RT, ST): no D1 reads, no timers. Counts stay in D1 (SA §13.1's rule holds).
- **Pass purge** (test mode) cascades its gate rows: counts drop with no rev bump; the next change or snapshot carries
  the true number.

### 2.4 Auto tap-out: the cron, not a Durable Object alarm

`scan.occupancy` (minute hook beside `scan.reconcile`): `DUE` (`due_at <= now`, index `scan_gates_due`, oldest first,
200 rows), then per row, in batches of 25: claim a `scans` row (actor `system`, `actor_key 'sys:occupancy'`,
idempotency key `auto:<pass>:<scope>:<last_at>`, method `auto`, direction `out`, `out_cause` `stay` or `clear`), `EXIT`
with CAS on the `last_scan_id` it read, `EXIT_BELOW`, `REV`, finalize or delete the claim, ledger. Then publish the
rows to orgs that have monitors. A tap at the same moment wins and the cron changes nothing; a retried run collapses on
the idempotency key (tested).

Why not the `ScanHub` alarm: occupancy must work for orgs with no screens (no hub), the hub has no D1 access by design,
one alarm per object would need its own schedule, and the cron already exists. A minute of lateness on a 12 h limit
doesn't matter.

**Due time** (`dueAt`): the earlier of `since + max stay` (elapsed time) and the next **Clear at** after `since`
(wall clock in the zone's time zone via AX's `instantOf`: a clear inside the spring-forward gap fires when the gap ends;
the repeated autumn hour fires at its first instance; tested). Set at entry; null on exit. A zone settings change
recomputes `due_at` for its inside rows in bounded batches; the job re-reads the zone before acting, so a stale due
time never taps out early (it re-arms instead).

### 2.5 Undo

Undo restores every row the scan changed (`last_scan_id = :undone`): rows it inserted are deleted, rows it changed take
`prev_*` back; `due_at` is recomputed for rows restored to `in`; AX's visit decrement applies. An override's group (the
grant and its forced-exit row, `group_id`) is undone together. A later change to any of the rows answers
`UNDO_SUPERSEDED` (SA). Tested: forced re-entry, children out, undo returns all.

### 2.6 Migration `0020_scan_access.sql` (AX's, extended; the reference is `MIGRATION_0020`)

Extend rather than add `0021`: nothing is built, the zone columns belong in `CREATE TABLE scan_zones`, and one file
keeps "zones" whole. Additions to SA §19.7's text:

```sql
-- inside CREATE TABLE scan_zones (after sort):
  -- Occupancy: off; track (count who's inside); enforce (track, and a second entry waits for a tap-out).
  occupancy TEXT NOT NULL DEFAULT 'off' CHECK (occupancy IN ('off', 'track', 'enforce')),
  capacity INTEGER CHECK (capacity IS NULL OR capacity BETWEEN 1 AND 100000),
  max_stay_minutes INTEGER CHECK (max_stay_minutes IS NULL OR max_stay_minutes BETWEEN 15 AND 2880),
  clear_at TEXT CHECK (clear_at IS NULL OR (clear_at GLOB '[0-2][0-9]:[0-5][0-9]' AND clear_at < '24:00')),
  ...
  CHECK (occupancy <> 'off' OR (capacity IS NULL AND max_stay_minutes IS NULL AND clear_at IS NULL))

-- Why a tap-out wasn't the holder's: max stay, the daily clear, Mark as out, or a forced re-entry.
ALTER TABLE scans ADD COLUMN out_cause TEXT CHECK (out_cause IS NULL OR out_cause IN ('stay', 'clear', 'desk', 'forced', 'zone'));
-- The desk's optional reason for an override.
ALTER TABLE scans ADD COLUMN override_note TEXT CHECK (override_note IS NULL OR override_note IN ('forgot_out', 'known', 'paid', 'other'));
-- One live override per scan: a scanner and a monitor letting the same person in race to one winner.
CREATE UNIQUE INDEX scans_override_once ON scans (override_of)
  WHERE override_of IS NOT NULL AND undone_at IS NULL AND state <> 'failed' AND (outcome IS NULL OR outcome = 'ok');

-- When the system taps a pass out of a zone (max stay or the daily clear). Null when out or no limit.
ALTER TABLE scan_gates ADD COLUMN due_at INTEGER;
CREATE INDEX scan_gates_due ON scan_gates (due_at) WHERE due_at IS NOT NULL;

-- Orders the In now counts monitors receive. One row per place ('zone:<id>' or 'event:<id>') and mode.
CREATE TABLE scan_place_revs (
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  place TEXT NOT NULL,
  rev INTEGER NOT NULL,
  PRIMARY KEY (org_id, mode, place)
) WITHOUT ROWID;
```

- Touches `scans` and `scan_gates` (SV's tables, 0014): additive columns and indexes only; reported to SV and
  integration. `scans_override_once` also closes SA's "not already overridden" race for scanner overrides.
- Service rules: Require tap out, capacity, max stay and clear need Track (the CHECK); Clear at needs a time zone on the
  root or the org (`ZONE_CLEAR_NEEDS_TZ`, 422); a scanner's Out or Both needs a tracked zone or a re-entry event
  (`SCANNER_DIRECTION_NO_PLACE`, 422); a terminal can't be Both.
- `test/migrations.test.ts` `describe('0020_scan_access')` gains: the occupancy CHECKs (capacity without track, `24:00`,
  `7:00`, max stay 5), `out_cause` and `override_note` CHECKs, the unique override index (an undone override frees
  it), `scan_gates_due` partial. `test/query-plans.test.ts`: inside count index-only, due rows, who's inside, revs.
- Retention: in/out rows live with the pass; `scan_place_revs` is one row per place.

---

## 3. Direction

### 3.1 The setting

| Direction | Device | Use |
| --- | --- | --- |
| **In** (default) | fixed chip **In** (no chip on a scanner with no place) | entry turnstile, a reader or phone at the way in; every scanner that doesn't count |
| **Out** | fixed chip **Out** | exit reader |
| **Both** | chip **Auto ⌄**: Auto, In, Out | one phone at the front desk; a pool gate used both ways |

`ScannerSettings.direction` (P0-11). A scanner's place: its event, else its first zone (in its order) that tracks
occupancy; other zones it checks stay access-only. The console names it under Checks: **Counts people in Gym · 42
inside now.** A scanner with no place ignores direction (Out and Both are refused at save).

### 3.2 Both: Auto by default

- **Auto** infers per scan from the in/out state: inside → out, otherwise in. Every result says which (the band pill **In** /
  **Out**, the strip **In · Gym · 6:41 PM**), so a wrong inference is seen at once and **Undo** is in the strip.
- **Why Auto, not a toggle:** at a front desk arrivals and departures interleave; a toggle is either flipped for every
  person or forgotten, and a forgotten toggle silently corrupts the counts all evening. Auto can't be forgotten, and the
  server decides atomically. Time and attendance clocks work this way for the same reason.
- **Pin:** the chip opens **Direction** (**Auto** *In if they're out, out if they're in.* · **In** *Every scan taps in.*
  · **Out** *Every scan taps out.*). A pin turns the chip teal and goes back to Auto after 15 min without a scan (a
  forgotten pin can't run all day). Per device, client state; sent as the explicit `direction` on each act.
- **Explicit beats inferred:** a dock action (**Tap out**, **Tap in**) and a pin send `direction`; the turnaround guard
  doesn't apply to them, anti-passback still does.

### 3.3 Double scans

| Layer | Rule |
| --- | --- |
| Client, same code | ignored 5 s after an ok, 30 s after a refusal (SA §7.5, unchanged) |
| Client, different code | accepted from T0 + 350 (unchanged) |
| Server, Auto | **turnaround guard:** a flip at the same place under 2 min after the last transition is held: inside → **Already in · 40 s ago · Front desk** with **Tap out**; outside → **Already out · 30 s ago · Front desk** with **Tap in** |
| Server, In door | Require tap out: **Already in**; track only: granted, `since` unchanged, no new visit inside the gap |

### 3.4 Readers at a door

Keyboard-wedge and NFC readers (and terminals) belong to one door and have no one to answer a hold, so they take a
fixed **In** or **Out**. The console says **A reader at a door: pick In or Out. One phone at the desk: Both.** A device
with two readers can't tell them apart (both type keystrokes): one scanner per door direction. A transfer door between
two sibling zones (Studio → Pool) is two readers, or later a per-zone direction on `scanner_zones` (seam; not now).

---

## 4. Forgotten tap-outs and capacity

### 4.1 Never locked out for good

| Path | Who | Records |
| --- | --- | --- |
| **Max stay** (default 12 h) | system | exit, `out_cause` `stay`, actor `system`, method `auto` |
| **Clear at** (daily, optional) | system | exit, `out_cause` `clear` |
| **Mark as out** | Desk and up: monitor (signed in), console (admin) | exit, `out_cause` `desk`, the staff member or admin |
| **Let in anyway** on **Already in** | the door per its `letInAgain` (default anyone), or the desk | a forced-exit row (`out_cause` `forced`) and the grant (`override_of`), one group |
| Turnaround **Tap out** | anyone at a Both scanner | an ordinary exit |

### 4.2 The trail

The pass's activity (Sync log, **Scans** filter) and the console's pass page (sheet `occ-console` 04):

| Row | Title | Detail |
| --- | --- | --- |
| entry | **Tapped in · Pool** | scanner · Auto · staff |
| exit | **Tapped out · Gym** | scanner · stayed 1 h 40 min |
| auto | **Auto tapped out · Gym** | Max stay 12 h (or Cleared 11:00 PM) · stayed |
| desk | **Marked as out · Gym** | Ana R. at Office iPad |
| override | **Let in · Gym** | Over Already in · forgot to tap out · Ana R. at Office iPad |
| forced | **Forced out · Gym** | By the override · in since Mon 7:10 PM |
| hold | **Already in · Gym entry** | In since … |

A card on top says where the pass is now (**Inside Gym, Pool · Since 5:31 PM · Pool gate · 1 h 12 min**) with **Mark as
out**, and how it ends (**Tapped out automatically after 12 h or at 11:00 PM.**).

### 4.3 What the holder sees (decided: Please see the desk)

On the customer screen **Already in** is **Please see the desk · Your last exit wasn't recorded.**, not *Tap out at the
exit first*: the holder is standing outside the entrance, and the exit reader is inside. Telling them to go there is
an instruction they can't follow; the desk fixes it in one tap. The sub says what happened, kindly, with no blame.

### 4.4 Capacity

- Exact (2.2). Shown as **In now 42 / 60** with a bar on the monitor rail, the scanner's count chip (**42/60**), the
  console's Zones list and, for events, the existing dashboard (**In now 312 / 500**).
- **Full** = amber `capacity_full`: **Pool full · 25 of 25 in.** Customer: **Please see the desk · We're full right
  now.** Amber because the pass is fine and staff talk (wait, or come back); red is for "this pass may not".
- **Override: Manager only** (signed in or PIN), zones and events. Capacity is a safety number (lifeguard ratio, fire
  code); SA's `letInAgain` no longer covers `capacity_full`. An override can pass capacity; the count says so (26 / 25,
  amber bar full).
- Implied parent entries check the parent's capacity unless the pass is already in it (review: a track-only parent
  can be entered through a child's own door). Answer **{Club} full**.

---

## 5. Reasons, copy, contracts, routes

### 5.1 Scanner copy (`SCAN_REASON_COPY`, `src/shared/copy/scan.ts`)

| Reason or verdict | Kind | Headline | Sub | Dock | Beat |
| --- | --- | --- | --- | --- | --- |
| entry ok | ok | **Access granted** (events **Checked in**) | pill **In** + zone (AX) | Undo in the strip | `gate` (`hop`) |
| exit ok | ok | **Tapped out** (events **Checked out**) | pill **Out** + **{zone} · {1 h 32 min}** | Undo | `bye` |
| `still_inside` | heads-up | **Already in** (events **Already checked in**) | **Since {9:12 AM} · {Front desk}** (under 60 min: **{40 s ago} · {Front desk}**) | In door: **Let in anyway** · **Done**; Auto: **Tap out** · **Done** | `wrist` (back) |
| `not_inside`, no entry | heads-up | **Not tapped in** (events **Not checked in**) | **No entry recorded.** (events: **Check them in instead?**) | **Done** (events: **Check in**) | `tilt` |
| `not_inside`, Auto after an exit | heads-up | **Already out** | **{30 s ago} · {Front desk}** | **Tap in** · **Done** | `wrist` (back) |
| `not_inside`, parent | heads-up | **Not tapped in** | **Tap in at {Gym} first.** | **Let in anyway** · **Done** | `tilt` |
| `capacity_full` | heads-up | **{Pool} full** (events **Event full**) | **{25} of {25} in.** | **Let in anyway** (Manager, shield) · **Done** | `wrist` (fwd) |
| after a desk override | ok | **Access granted** | **{Pool} · Let in by {Sam K.}** | strip **Let in by Sam K. at Office iPad** | `relent` + `gate` |

Placeholders: `time`, `ago`, `scanner`, `zone`, `place`, `stay`, `in`, `capacity`, `staff`. The capsule's count chip on
a scanner with a place is **In now / capacity** (`Users`), else today's count (SA).

### 5.2 Customer copy (`CUSTOMER_COPY`)

| Outcome | Screen | Headline | Body |
| --- | --- | --- | --- |
| entry ok | ok | **Access granted**, sub the zone | **Hi, Maya** + plan chip (AX) |
| exit ok | ok | **Tapped out**, sub the zone | **Bye, Maya** · `Clock` **Stayed 1 h 32 min** |
| `still_inside` | see_desk | **Please see the desk** | sub **Your last exit wasn't recorded.** |
| `capacity_full` | see_desk | **Please see the desk** | sub **We're full right now.** |
| `not_inside` on an exit | — | nothing published to the customer: leaving never stops anyone | |
| `not_inside` (parent) | see_desk | **Please see the desk** | none |
| a desk override of a shown see_desk | ok | as entry ok (never who let them in, never "override") | |

Counts, who is inside, the reason code and staff names never reach a customer screen (ST S6).

### 5.3 Phase 0 contracts (section 9 has the list) and later ones

```ts
// src/shared/contracts/scan.ts (P0-10..12)
SCAN_HEADS_UP_REASONS += ['still_inside', 'not_inside'];
ScannerSettingsSchema.direction = z.enum(['in', 'out', 'both']).default('in');
ScanOccupancySchema = z.object({
  place: z.object({ kind: z.enum(['zone', 'event']), id: IdSchema, name: z.string() }),
  direction: ScanDirectionSchema,                 // what this scan did or asked
  auto: z.boolean(),                              // inferred on a Both scanner
  state: z.enum(['in', 'out']),                   // after this scan (or now, on a card)
  since: TimestampSchema.nullable(),              // in: since; out: when they left
  via: z.string().nullable(),                     // the scanner of the last transition
  stayMs: z.number().int().nullable(),            // on an exit
  inNow: z.number().int().nullable(),             // the place's count, when the scanner may see it
  capacity: z.number().int().nullable(),
  turnaround: z.enum(['in', 'out']).nullable(),   // a held Auto flip: the dock's one-tap direction
});
ScanOutcome.occupancy, ScanCard.occupancy: ScanOccupancySchema.nullable().default(null);
ScanCounts.place: z.object({ name, inNow, capacity }).nullable().default(null);
```

Later, additive (stream OC unless noted):

| File | Names |
| --- | --- |
| `contracts/access.ts` (AX) | `ScanZoneSchema` + `occupancy`, `capacity`, `maxStayMinutes`, `clearAt`, `inNow`; `Update/CreateScanZoneSchema` the same; `ZONE_CLEAR_NEEDS_TZ` |
| `contracts/scan-occupancy.ts` (new) | `OccupancySettingsSchema`, `ScanInsideRowSchema` (`{ passId, holder, photoUrl, plan, place, since, via, flags: ('long_stay' \| 'pass_ended')[] }`), `ScanInsideListSchema` (≤ 100, `total`, cursor), `ScanOverrideRequestSchema` (`{ idempotencyKey, overrideOf, approval?, note? }`), `ScanOverrideNoteSchema`, `ScanMarkOutRequestSchema` (`{ idempotencyKey, passId, place, approval? }`), `OVERRIDE_NOTES` |
| `contracts/scan-live.ts` (ST) | `ScanMonitorRow` + `occupancy`, `places[]`, `outCause`, `overrideOf`, `resolvedBy`; `ScanCustomerView.replaces: UuidV7 \| null`; `LiveEvent` + `resolved { of, outcome, by }` (to `dev:<scanner>`); `ScreenSettingsSchema.actions: boolean` (default false); `ScanLiveSnapshot.counts.places[]` |
| `contracts/scanners.ts` (SC) | `ScanRecord.outCause`, `.overrideNote`, `.occupancy`; `ScanListQuery.outCause` |
| `contracts/events.ts` | none: `scan.checked_in` / `scan.checked_out` with `data.place`, `data.outCause`, `data.auto`, `data.overrideNote` |

### 5.4 Routes

| Method and path | Guard | Body → result |
| --- | --- | --- |
| `POST /api/v1/scan/overrides` | scan actor (scanner, monitor with Desk actions, admin), CSRF, `RL_SCAN`, `scan:ovr` | `ScanOverrideRequest` → `ScanOutcome` |
| `POST /api/v1/scan/overrides/{scanId}/note` | the override's actor, ≤ 2 min | `{ note }` → 204 |
| `POST /api/v1/scan/mark-out` | scan actor, Desk+, CSRF, `scan:ovr` | `ScanMarkOutRequest` → `ScanOutcome` (exit, `out_cause` desk) |
| `GET /api/v1/scan/live/inside?place&cursor` | live principal, monitor | → `ScanInsideList` (watch-scoped) |
| `POST /api/v1/scan/staff`, `DELETE` | now also monitors with Desk actions | staff sign-in on the monitor |
| `GET /api/v1/scan-zones/{id}/inside` | `requireAdmin` | → `ScanInsideList` |
| `POST /api/v1/passes/{id}/mark-out` | `requireAdmin`, CSRF, audited | `{ place }` → 204 |
| `PATCH /api/v1/scan-zones/{id}` (AX) | | + occupancy settings; recomputes due times |
| `PATCH /api/v1/scanners/{id}` (SC) | | `settings.direction`; monitors `screen.actions` |

Errors: `SCAN_OVERRIDE_INVALID` 422 (widened, 6.4), `SCAN_OVERRIDE_TAKEN` 409 (the unique index: someone else was
first; copy **Ana R. already let them in.**), `SCAN_TOO_MANY_OVERRIDES` 429, `NOT_INSIDE` 409 (Mark as out on someone
already out), `SCANNER_DIRECTION_NO_PLACE` 422, `ZONE_CLEAR_NEEDS_TZ` 422.

### 5.5 Ledger, events, audit

- **Ledger (Sync log):** reuse `scan.checked_in` (entries, overrides) and `scan.checked_out` (every exit) with
  `data.place`, `data.zoneId`, `data.direction`, `data.auto`, `data.outCause`, `data.override`, `data.overrideNote`.
  Auto exits are actor `system`. Decided: no `scan.entered/exited/auto_exited`: one meaning per kind (in, out), the
  cause is detail; filters and tones keep working.
- **Audit:** `scan.override` (existing) gains `detail.via` (`scanner` | `monitor` | `console`), `of`, `note`;
  new `scan.mark_out` (Mark as out; scanner or user; target pass); `scan.overrides_capped` (once per hour per
  device). Zone and scanner settings ride `scan_zone.update` and `scanner.update`. Auto tap-outs aren't audited (they
  are scans).

### 5.6 Guard order (SA §2.6, amended)

Steps 1-9 unchanged. Then:

| Step | Check | Answer |
| --- | --- | --- |
| **9a** | direction: explicit, else the scanner's, else Auto from the in/out state in the place; Auto flip under 2 min after the last transition | held heads-up `still_inside` / `not_inside` with `occupancy.turnaround` |
| exit | skip 10-14; in → out (cascade) | ok **Tapped out**; not inside → heads-up `not_inside` |
| 10, 10a-10e | entry only (AX) | as AX |
| 13-14 | entry only | as SA (capacity leaves step 14: it is in 15) |
| **15** | entry: `not_inside` (parent) → `still_inside` → `cooldown` → `guest_visits_used` → `capacity_full`, all in one statement | heads-up or refused |
| 16 | effect | ok with `occupancy` (and `access`) |

`ready` (desk card) runs 9a-15 as reads: the card shows **Inside since 9:12 AM** and the dock shows the direction it
would take.

---

## 6. Desk overrides

### 6.1 What the desk can do

| Answer at the door | Kind | Desk action | Needs | What it records |
| --- | --- | --- | --- | --- |
| `zone_not_included`, `outside_hours`, `not_yet_valid` (access) | refused | **Let in** | Manager | grant (`override_of`), in (+ implied), visit |
| `guest_expired`, `guest_visits_used` | refused | **Let in** | Manager | the same; the visit can pass the limit (AX) |
| `still_inside` | heads-up | **Let in** | the door's `letInAgain` | forced-exit row + grant; `since` resets; children out |
| `not_inside` (parent) | heads-up | **Let in** | the door's `letInAgain` | grant + implied parent entries |
| `capacity_full` | heads-up | **Let in** | Manager | grant; count passes capacity |
| `cooldown` (AX wait) | heads-up | **Let in** | the door's `letInAgain` | grant |
| `already_done`, `not_yet_valid`, `ended` (events) | heads-up | **Let in again** | the door's `letInAgain` (SA) | check-in |
| anyone inside (forgotten tap-out) | — | **Mark as out** | Desk | exit, `out_cause` desk |
| `not_inside` on an exit | heads-up | none: they left | — | — |
| `voided`, `removed`, `expired` (non-guest), `suspended`, `test_pass`, `live_pass`, `not_found`, `not_accepted`, `wrong_event`, `ambiguous` | refused | **Seen** only | never | — |

The soft/hard split is AX's (§2.8) plus the in/out holds. "The door's `letInAgain`" means the refusing scanner's
setting: the door's policy follows the scan wherever it is overridden; `never` closes it for the desk too.

### 6.2 What one tap does

1. **State:** `act()` runs as an override of the referenced scan, with that scan's pass, action, place, event and
   direction (the monitor sends only `overrideOf`; it can't redirect anything). It records the entry, the forced exit
   when the pass was inside, the in/out rows (implied ancestors, children out) and AX's visit, in one batch.
2. **Alert:** the override's monitor row carries `overrideOf`; every monitor marks the original row **Resolved by Ana
   R.** and unpins its alert.
3. **Screens, live** (6.5): the refusing scanner gets `resolved` on its socket; its station's customer screen gets the
   override's customer body with `replaces` = the refused request's `ref`.
4. **Attribution:** the new `scans` row is the monitor's (`scanner_id` = the monitor, `staff_id` = the signed-in staff,
   `approved_by` = the Manager PIN if any), with the original's `zone_id`, `station_id`, `event_id` (where the person
   stands). Audit `scan.override` with `via: 'monitor'`.

### 6.3 Permissions (decided)

| Option | Verdict |
| --- | --- |
| Monitor setting **Desk actions** | **yes, the gate:** off by default (ST's read-only monitor stays the default; a lobby wall screen never acts) |
| Staff sign-in on the monitor | **yes, required to act:** the existing PIN binding on the device row (15 min idle, 12 h, Switch staff). Every action has a person. Without sign-in the buttons read **Sign in to act** |
| The monitor's paired role or audience | no: the role says what it shows; rights come from the person, as on scanners (SA D4) |
| Manager PIN per risky override | **yes:** Full, guest limits and the AX no-access refusals need a Manager, signed in or by PIN for that one action (SA `approval`) |

The monitor's rights are its signed-in staff member's role (Door, Desk, Manager); a device alone never has Manager
rights (SA §2.2). A Door monitor audience can still act if its staff can: audience filters content, not rights.

Guard: routes declared with `screenActions: true` (overrides, the note, mark-out, undo of its own scans, staff) admit
a `monitor` device whose `screen.actions` is on; everything else stays `SCREEN_ONLY` (customer screens never act).
SA §2.5.

### 6.4 The override guard, widened (SA §2.6 "Overrides")

`overrideOf` must name a `scans` row that is:
- the same org and mode as the actor, with a pass, outcome `heads_up` or `refused` and a reason the actor may override
  (6.1);
- written **by the same `actor_key`** (a scanner overriding its own answer), **or by any device whose station, zone or
  event the acting monitor watches** (`watchCovers(monitor.watch, row)`), **or any device of the org** for an admin
  session;
- at most **15 minutes old** (the monitor's live window; SA's 10 widens to 15 for all);
- not already overridden (`scans_override_once`: a racing second override gets 409 `SCAN_OVERRIDE_TAKEN`).

Anything else: 422 `SCAN_OVERRIDE_INVALID` with the body of an unknown id (no probing across watches). The rights check
uses the refusing scanner's `letInAgain` and the actor's role (6.1).

### 6.5 Screens flip on the fly

**Hub targets** for an override: the original scan's station (customer body), the monitors whose watch covers it (row),
and **`dev:<refusing scanner>`** with a `resolved { of: scanId, outcome, by: { staff, device } }` event (the outcome
role-filtered for that scanner's role). Scanners already hold a socket when the org has screens (ST); a desk override
implies a monitor, so they do.

**The scanner** (`occ-flip` 01-04):
- If the refused card for `of` is up, or it is the device's latest verdict and under 60 s old: the card **turns** in
  place, no re-mount. Tint and ring cross-fade 240 ms; the band wipes green left to right (240 ms, `--e-out`) while the
  octagon rotates into the check circle; headline cross-fades to **Access granted**, sub **{zone} · Let in by {staff}**;
  the strip reads **Let in by Sam K. at Office iPad**. Hold 1.2 s like any grant, then tuck.
- Otherwise (a newer verdict is up, or idle past 60 s): no card; the strip row for `of` turns green with the same meta
  and a 2 s highlight. Never interrupts the next person.
- No Undo on the scanner for someone else's override (SA undo rules); the desk owns it.

**The customer screen** (`occ-flip` 05-08): it shows the override only if its current view is the `see_desk` for
`replaces`, or idle within 60 s of it; then the slate card tucks (150 ms) and the green one rises (BF swap), with the
normal ok view (**Access granted** · **Hi, Maya**). Otherwise it drops it: never over the next customer.

**The buddy, `relent`:** a prefix in the beat's 150 ms delay, then the grant's own beat.

| T0 + ms | Motion |
| --- | --- |
| 0-60 | "Oh": eyes pop to 1.06 × 1.22 and up 0.6; sad brows lift 1 unit; body 0.99 × 1.02 |
| 60-150 | mood sad → happy (120 ms fade, ME's allowance) |
| 150-700 | `gate` (access) or `hop` (event check-in), as BM |

Cut-safe (eyes and brows only before 150). Reduced motion: the destination's end pose at once. Customer screens: from
`sorry` the same prefix, then `gate`. The monitor's own buddy plays BM's `nod` once when its staff override (throttled
with alerts, 1 per 2 s).

### 6.6 Undo

- **Toast** on the monitor for 8 s: **Leo Park let in · Gym** · **Why?** chips (**Forgot to tap out** · **Known to
  staff** · **Paid** · **Other**) · **Undo**. A reason chip posts the note (≤ 2 min). Undo is one tap.
- **Row menu:** **Undo** for 10 min (SA `scan.undoWindowMinutes`, own scan: same device and staff member), as any undo.
- Undo restores the in/out rows and visits (2.5), marks the group undone, re-opens the original's alert as **Override undone**,
  publishes `undo` to the station (customer screen goes idle) and to the refusing scanner (its strip row returns to red).

### 6.7 Abuse guards

- Desk actions off by default; sign-in required; Manager for the risky ones.
- Only scans in the monitor's watch, under 15 min old, once each.
- `scan:ovr:<actorKey>`: 120 overrides and Mark-as-outs per hour per device, then 429 `SCAN_TOO_MANY_OVERRIDES` and
  `scan.overrides_capped` audited once. PIN misses reuse `scan:pin:<monitorId>:<staffId>` and `scan:pinall:<monitorId>`
  (SA §2.7). `RL_SCAN` applies to every route.
- Every override is attributed (staff, approving Manager, device), audited, in the Sync log, counted on the monitor rail
  (**Let in 3**) and in the Scans log (`?override=true`).
- Logs: ids and codes only (`scan.override.ok`, `scan.override.taken`, `scan.occupancy.auto_out`).

---

## 7. UX

### 7.1 Scanner

Sheets `occ-scanner-phone`, `occ-scanner-ipad`.
- **Capsule:** a direction chip after the name: fixed **In** / **Out** (no chevron), or **Auto ⌄** on Both; a pinned
  **In ⌄** / **Out ⌄** is teal. The count chip shows **42/60** (`Users`) for a scanner with a place.
- **Band:** the pill **In** / **Out** leads the sub, before the zone pin.
- **Holds** are amber with the clock (`wrist`), or the head tilt for **Not tapped in**; never the head shake.
- **Direction sheet:** three radio rows and the lapse line; **Done**.
- iPad: the split card; the pill sits in the verdict column's sub.

### 7.2 Customer screen

Sheet `occ-customer`. Entry unchanged. Exit: **Tapped out**, **Bye, Maya**, **Stayed 1 h 32 min**, the buddy waves
goodbye (`bye`). Holds: **Please see the desk** with the kind subs of 5.2.

### 7.3 Desk monitor

Sheets `occ-monitor-desk` (1440), `occ-monitor-ipad` (1180).
- **Rail:** **In now** card: the watch's top tracked zone large (**42 / 60**, bar), tracked children below it indented
  with their own count and bar; a full zone turns its bar and number amber and says **Full**. Then **Visits** and **Let
  in** (overrides today). Devices and the buddy as ST.
- **Capsule:** the staff chip **Ana R. · Desk** with sign-out, or **Sign in** when Desk actions are on and nobody is.
- **View tabs:** **Feed** · **Inside 42**.
- **Alerts:** with Desk actions on, actionable heads-ups pin too (amber ring), not only refusals: **Pool full** ·
  **Maya Okafor · Pool gate · 25 of 25 in.** · photo · **Let in** (shield when a Manager is needed) · **Seen**. Max 3,
  newest first. Without Desk actions: refusals only, as UX.
- **Feed rows** gain an action column: **Let in** on overridable rows under 15 min old; results show the direction
  icon (**→ Access granted**, **← Tapped out**), system rows (**Auto tapped out · Max stay 12 h**) are dimmed, override
  rows are green with a shield (**Access granted · Let in by Ana R. · forgot to tap out**), resolved holds read
  **Resolved by Ana R.**
- **Who's inside:** longest first; columns Who (photo, name, plan chip) · Zone (with its parent) · In since (time,
  stay, flags **Long stay** past 75 % of max stay, **Pass ended**) · Via (scanner, staff; hidden on iPad) · **Mark as
  out**. Summary **42 in Gym · 2 long stays**. Rows under a flag are tinted amber and their button filled.
- **Manager PIN:** a centred card over the dimmed monitor: **Manager PIN** · **Let Maya Okafor into Pool?** · the held
  answer (**Pool full · 25 of 25 in · Pool gate · now**) · Manager picker · six dots · keypad · **Cancel**. The alert's
  button shows **Letting in…** meanwhile.
- **Toast** (6.6) at the foot of the feed.

### 7.4 Console

Sheet `occ-console`.
- **Zone dialog**, section **Occupancy:** **Track who's inside** *Counts people in and out. Monitors show In now.* ·
  **Require tap out** *A second entry waits for a tap-out. Put an Out or Both scanner at the exit.* · **Capacity**
  (*people*; help **Full stops new entries. A Manager can let someone in.**) · **Max stay** (help **Anyone still in
  after this is tapped out.**) · **Clear at** (the zone's clock; help **Everyone still in is tapped out at this time.
  Empty: never.**) · status **25 inside now. Counted by Pool gate (Both).** Fields under Track disable when it is off.
- **Zones tab:** columns **Occupancy** (**Tap out required** / **Counts** / —) and **In now** (**42 / 60**).
- **Scanner dialog, Direction:** tiles **In** *Every scan taps in.* · **Out** *Every scan taps out.* · **Both** *Auto:
  in if they're out, out if they're in.*; help **A reader at a door: pick In or Out. One phone at the desk: Both.**;
  status **Counts people in Gym · 42 inside now.**
- **Desk monitor dialog:** switch **Desk actions** *Staff sign in here to let people in and mark them out. Full and
  guest limits ask for a Manager.*; callout **Every action is signed by the staff member and shows in the pass's
  activity.**
- **Pass › Activity:** the where-now card and the trail (4.2).
- Template designer, Access › Rules: the re-entry wait's help gains **Zones that require tap out usually don't need a
  wait.**

### 7.5 Buddy beats (BM §6, §8)

**`bye`** (new, green, every exit; replaces `dip`). Happy. No prop (the teal pass is the hand). Chirp `ok`.

| T0 + ms | Motion |
| --- | --- |
| 150-260 | The teal pass rises to −52° (34° past its rest, inside §7.5's 36°), like a hand; the trunk leans 3° toward the exit; eyes up-right 1.2 |
| 260-410 | First wave: −52° → −38° → −52°; two motion lines fade in beside it |
| 410-560 | Second wave |
| 560-700 | The hand comes down to rest; lines fade; happy arcs |

Snap at cut ≤ 34° on the teal pass, ≤ 1 unit on the body. Reduced motion: hand up at −52° with the lines, happy.
Customer screens play it at XL.

Beat-map rows: exit → `bye`; `still_inside` → `wrist` (back); `not_inside` → `tilt` (Auto after an exit: `wrist`
back); `capacity_full` → amber `wrist` (fwd), replacing BM's red capacity row; a desk override → `relent` + the grant's
beat. Customer screens: holds → `sorry` (never shake or wrist, BM §17).

### 7.6 Accessibility

Verdict = colour + glyph + words; the direction pill and the chip carry text (**In**, **Out**, **Auto**) and an
`aria-label` (**Direction: Auto**). The turnaround hold's dock action is the focused element. Monitor: **Let in**,
**Mark as out** and **Seen** are 44 px buttons; the PIN card traps focus; the toast is `role="status"`, Undo reachable
by keyboard for its 8 s and from the row menu after; the inside list is a table with row headers. Customer screens
announce **Tapped out. Bye, Maya.** once. Targets ≥ 44; AA in both themes (the kit's tokens).

---

## 8. Mockups

All light and dark, generated from `gen/` with Playwright (`next/node_modules`), reduced motion (stills are frames).

| Sheet | Tiles |
| --- | --- |
| `sheets/occ-scanner-phone-{light,dark}.png` | Tap in · Auto; Tap out · Auto (`bye`); Already in (Require tap out); Already in · Auto turnaround; Not tapped in (exit); Not tapped in (parent first); Pool full; the Direction sheet |
| `sheets/occ-scanner-ipad-{light,dark}.png` | The same six on iPad 1180 |
| `sheets/occ-customer-{light,dark}.png` | Tapped in; Tapped out (Bye, Maya); Already in → see the desk; Full → see the desk; iPad out and hold |
| `sheets/occ-monitor-desk-{light,dark}.png` | In now and overrides; Manager PIN; Let in done (toast, reason, Undo); Who's inside with Mark as out; Desk actions on, nobody signed in (1440) |
| `sheets/occ-monitor-ipad-{light,dark}.png` | The same five at 1180 |
| `sheets/occ-console-{light,dark}.png` | Zone occupancy settings; scanner Direction; monitor Desk actions; the pass's in/out trail (1440) |
| `sheets/occ-flip-{light,dark}.png` | A desk override reaching the scanner (4 frames: refused, the "oh" and band wipe, gate lifting, rest) and its customer screen (4 frames: see the desk, swap, granted, rest) |

---

## 9. Phase 0 amendments

> **Superseded** by `addendum/p0-amendments.md`: P0 takes P0-9 and P0-10 (two reasons, one default line each;
> `capacity_full`'s copy unchanged). P0-11 to P0-14 land later; P0-14 became `screenActions?: boolean`.

### Now (before `next/n8-p0` merges; frozen files only; on top of P0A's P0-1..P0-8)

| # | File | Change | Why now |
| --- | --- | --- | --- |
| **P0-9** | `migrations/0014_scan.sql` + `test/migrations.test.ts` | `scans.actor_type` CHECK + `'system'`; `scans.method` CHECK + `'auto'`. Tests: a system/auto row inserts; `'robot'` fails | **Must.** Both CHECKs sit on `CREATE TABLE scans`; after merge, auto tap-outs would need a rebuild of the busiest table. Verified: without it the reference's auto tap-out insert fails (`gen/occupancy.test.mjs` first case) |
| P0-10 | `src/shared/contracts/scan.ts`, `src/shared/copy/scan.ts` (+ tests) | `SCAN_HEADS_UP_REASONS` + `still_inside`, `not_inside` with 5.1's copy; `capacity_full` headline `{place} full` | freezes the reason list once (as AX P0-5); the "every reason has a line" test covers them |
| P0-11 | `src/shared/contracts/scan.ts` | `ScannerSettingsSchema.direction: z.enum(['in','out','both']).default('in')` | the settings DTO and session are frozen and read by SC, AD and CC; existing rows parse to `in` |
| P0-12 | `src/shared/contracts/scan.ts` | `ScanOccupancySchema`; `ScanOutcome.occupancy`, `ScanCard.occupancy` (nullable, default null); `ScanCounts.place` (nullable, default null) | fixtures stay valid; the client paints from one shape from M1 |
| P0-13 | `src/shared/copy/scan.ts` | `verdict.tappedOut` **Tapped out**; actions `tapIn` **Tap in**, `tapOut` **Tap out**, `markAsOut` **Mark as out**, `letIn` **Let in**, `signInToAct` **Sign in to act** | one copy file, frozen |
| P0-14 | `src/worker/modules/scan/guard.ts` | P0-3's `GuardOptions.screens?: boolean` (built) becomes `screens?: 'read' \| 'act'`; the two callers pass `'read'`; `'act'` is unused until OC | avoids changing the option's meaning on every screen route later; a one-word type |

Checked against `next/n8-p0` at `18ca03c`: P0-2, P0-3 and P0-5 are in; `scans.actor_type` and `scans.method` still
lack `system` and `auto`. About 60 changed lines plus tests. No route, table or binding. Commits:
`feat(scan): system scans for occupancy in 0014`, `feat(scan): occupancy reasons, direction and outcome field`.

### Later (stream OC; additive; nothing renames or narrows a frozen contract)

`0020` as extended (AX.1 writes it from 2.6 verbatim); `contracts/scan-occupancy.ts`; the `scan-live.ts`,
`access.ts`, `scanners.ts` additions (5.3); `rules.ts` policy kinds `mark_out` (Desk) and `capacity_override`
(Manager), and `letInAgain` no longer covering `capacity_full`; the override and mark-out routes; the cron hook; the
hub `resolved` event; every UI.

---

## 10. Build

> **Superseded** by plan §5.17 and §3: OC owns the server core, `routes-overrides`, `routes-occupancy`,
> `contracts/scan-occupancy.ts` and the pass's occupancy card; faces go to UI.9, CD.3, MN.2, BU.8, AD.11; zones to
> AX.6; hooks to SV.11, ST.6, SC.10, DS.8; e2e and cron to IN.7.

### 10.1 Milestone and stream

**M3B Occupancy**, after M2A (zones) and M3A (monitors, the hub), in the release (**Release needs M1-M4, M2A, M3A,
M3B**). **SA M3's "re-entry and check-out" moves into OC.1**, so events and zones get one implementation.

| Task | Needs | Delivers |
| --- | --- | --- |
| OC.1 Occupancy core | AX.1 (0020 as extended), SV.10 | `modules/scan/occupancy/{rules,repo,service}.ts` from `gen/occupancy.mjs`; step 9a, the exit path, step 15's in/out part, events re-entry and exact capacity; undo; `ScanOutcome.occupancy`; ledger data. Tests 11.1 |
| OC.2 Auto tap-out | OC.1 | `occupancy/jobs.ts` (`scan.occupancy` in `jobs/cron.ts`), due recompute on zone saves. Tests: due, CAS, idempotency, DST, bounds |
| OC.3 Scanner UI | OC.1, UI.8, BU.6 | the direction chip and sheet, the band pill, holds and docks, the count chip, `bye`, beat-map rows |
| OC.4 Monitor | OC.1, MN.1, ST.3 | In now rail, counts with revs, Who's inside (`/live/inside`), Mark as out |
| OC.5 Desk overrides | OC.4, M2's approvals | `/scan/overrides`, the guard widening, monitor sign-in, `resolved` events, scanner turn and customer replace, `relent`, toast and Undo, `scan:ovr` |
| OC.6 Console | AX.3, AD.9 | zone Occupancy fields, Zones columns, scanner Direction, monitor Desk actions, pass where-now card and trail, `/passes/{id}/mark-out` |
| OC.7 e2e and devices | all | `e2e/16-scan-occupancy.spec.ts`; device checks (a gym evening with one Both phone and two doors) |

### 10.2 Files (stream OC unless noted; each under 300 lines)

`src/worker/modules/scan/occupancy/{rules,repo,service,jobs,inside}.ts`, `modules/scan/{routes-overrides,
routes-occupancy}.ts`, `contracts/scan-occupancy.ts`; `src/web/scan/ui/direction-chip.tsx`,
`src/web/scan/sheets/direction-sheet.tsx`, `src/web/scan/monitor/{inside,override,pin-card,toast}/**`,
`src/web/admin/scanning/zones/occupancy-fields.tsx` (AX's folder, asked), `src/web/admin/passes/detail/occupancy-card.tsx`.

Shared touches, each small and reported: SV `resolve.ts`, `act.ts`, `undo.ts`, `rules.ts` (9a, the exit path, the
override widening); AX `modules/scan/access.ts` (statement 1 takes the AX guard); ST `live/{publish,rows,tags,
snapshot}.ts` (`places`, `resolved`, `dev:` target), `scan-live.ts`; SC scanner settings and DTOs; BU `beat-map.ts`,
`bye`, `relent`; AD devices dialogs; DS none; integration `jobs/cron.ts` registration (owned by the jobs port, additive).

---

## 11. Tests

### 11.1 Reference (done here, `gen/occupancy.test.mjs`, 23 pass)

P0-9 needed; 0020 CHECKs; anti-passback with two doors (one entry, one `still_inside`, one visit); track-only re-entry
keeps `since`; exit without entry and a double tap-out; exact capacity under a race and an override past it; nested
(enforcing parent required, implied entries, cascade out, roll-up counts); a parent exit racing a child entry in both
orders; guest limit and wait leave the in/out state still; forced re-entry, children out, undo restores; revs only on wins;
auto tap-out with CAS and idempotent claims; `dueAt` (max stay, clear, spring gap, autumn repeat, next day); direction
and the turnaround hold; one live override per scan (a lost one frees it); org and mode isolation; query plans.
Review additions: undo superseded at another place changes nothing; door-staff waivers meet the guest limit and
capacity behind them; an implied parent's capacity; implied rows' own due time; a row past due reads as out.

### 11.2 Worker (`vitest-pool-workers`, `makeEnv()`, real D1)

- The full order 9a-16 on an access template in a tracked zone: each reason once, in order (a guest out of visits at a
  full pool answers `guest_visits_used`).
- Races: two scanners enter one pass; enter vs exit; ten passes for one place at capacity 25 → exactly 25; a parent
  exit vs a child entry; the cron vs a tap.
- Exits: a voided, suspended, ended or outside-hours pass taps out `ok`; a mode mismatch and another org's pass don't.
- Auto: Both infers, the 2-min hold, an explicit direction skips it; a pinned In.
- Events: re-entry in and out on the same statements; `still_inside` and `not_inside` copy variants; exact event capacity; once-only
  events unchanged.
- Cron: 200-row bound and continuation; `CRON_QUERY_BUDGET`; publishes once per org with monitors, none without.
- Counts: monitor rows carry `places` with increasing revs; a misordered publish never lowers a client count
  (live-store unit test); snapshot equals `count(*)`.
- Overrides: a monitor overrides a scanner in its watch (ok), outside its watch (422, unknown-id body), over 15 min
  (422), twice (409 `SCAN_OVERRIDE_TAKEN`), a hard refusal (422); rights: Door staff on `still_inside` with
  `letInAgain: manager` → `needs_approval`, a Manager PIN → ok; capacity always Manager; a customer screen → 403; a
  monitor with Desk actions off → 403 `SCREEN_ONLY`; no staff signed in → 403 `STAFF_REQUIRED`; `scan:ovr` cap → 429.
- Live: an override publishes `resolved` to `dev:<scanner>` only, a customer body with `replaces`, monitor rows with
  `overrideOf`; undo publishes `undo` to the same targets.
- Isolation: zones, in/out rows, counts and the inside list never cross org or mode; a test monitor sees no live
  occupancy.
- Time zones: Clear at in a root zone's zone vs the org's; a stay across DST taps out at the wall-clock clear.
- Logs: no names, codes or zone names (ids only).

### 11.3 Unit and web

`direction-chip` (fixed vs Both, pin lapse with fake timers); the scanner reducer's turn-in-place vs strip-only rule
(latest verdict, 60 s); the customer `replaces` rule (only over the matching see_desk, never over the next customer);
`relent` frames (0, 60, 150, 390, 700) and the cut; `bye` frames and the 34° bound; the monitor's alert pinning with
and without Desk actions, toast timing, Undo focus, the PIN card's lockout copy; axe at 1440, 1180, 390 in both themes.

### 11.4 e2e (`e2e/16-scan-occupancy.spec.ts`)

Zones Gym (Require tap out, 60) and Pool (Track, capacity 2); a Both phone at the desk, an In door and a monitor with
Desk actions; on a test clock: tap in, tap out by Auto, a double scan held, **Already in** at the In door, the monitor
lets them in with one tap (the door's card turns green and the customer screen shows **Access granted** within 300 ms
locally), Pool full, a Manager PIN override, Mark as out from **Inside**, max stay auto tap-out after the clock moves
12 h, Undo of an override.

---

## 12. For the owner

1. **Full needs a Manager**, for zones and events. Today's design lets door staff override **Event full** under
   `letInAgain`; this tightens it because capacity is often a safety limit. Agree?
2. **Already in** can be overridden by anyone at the door (the door's `letInAgain`, default anyone), since it is
   usually a forgotten tap-out and the photo is on screen. Stricter gyms set the scanner to **Manager**. Keep anyone as
   the default?
3. **Max stay defaults to 12 h** when a zone starts tracking. A 24/7 gym might want 6 h; an office 14 h. Keep 12?
