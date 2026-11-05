# Stations: scanners, customer screens and desk monitors

> **Folded 2026-11-05** into SA §18, DM §11, SD §16, BM §17 and the plan (§5.11, M3A); those win. Changes made in
> the fold: the column is `device_role` / `deviceRole` (not `role`); the guard refuses screens after the rate limits
> (SA §2.5 step 4); the hub is declared in wrangler's `exports`, not `migrations`; `customer.chips` is ≤ 2 per header
> with schema `max(18)`; three customer refusals carry a sub (AX C2); e2e is `16-scan-stations`. Phase 0 changes:
> `p0-amendments.md`.


Addendum to `scanner-architecture.md` (**SA**), `display-model.md` (**DM**) and `scanner-plan.md` (**PL**) for the
owner's multi-screen requirement. Transport research: `cloudflare-realtime.md` (**RT**); Access cards and zones:
`access.md` (**AX**). Status: designed, ready to build after Phase 0. 2026-11-05.

> "I'd also like a multi-screen system as well for the scanners. This would be something like one or more handheld
> scanners being used a customer interface while a desk interface shows the scans in realtime. Or having two handheld
> scanners, one used as a scanner while the other is a customer interface. Any combination of them should be possible."

Precedence: this file wins over SA, DM and RT on stations, screen roles, the live transport and the customer audience.
SA keeps everything else. AX wins on zones and access semantics; this file only routes zone ids. UI layouts and
states for the screens are in `ux.md` and `sheets/`; this file fixes concepts, data, transport and copy.

Sheet: `stations/sheets/stations-topology-{light,dark}.png` (every combination, who sees what, the device flip).
Render: `node stations/gen/topology.mjs` from `addendum/`.

---

## 0. Decisions

| # | Decision |
| --- | --- |
| S1 | **Every paired thing is a device row in `scanners`** (no new credential table, no second pairing flow). A device has a **kind** (its ceiling: `device`, `terminal`, new `display`) and a **role** (what it does now: `scan`, `customer`, `monitor`). Code keeps the name `scanners`; the console tab becomes **Devices**. |
| S2 | **Roles, in the UI:** **Scanner** (`scan`), **Customer screen** (`customer`), **Desk monitor** (`monitor`). A `display` device can only be a Customer screen or a Desk monitor. A `device` (a paired phone) can flip between Scanner and Customer screen. A `terminal` is always a Scanner. |
| S3 | **A station is a named place: the scanners and customer screens at one counter or door.** A Customer screen shows the results of every scanner in its station. A device is in **at most one** station, so a customer's name and balance only ever appear on the screen beside them. |
| S4 | **A Desk monitor watches a scope, not a station:** its own station, up to 8 stations, an event, up to 8 zones, or the whole org. Many monitors can watch one scanner. That is how "a scanner on two stations" and "a monitor across an event or zone" are met without double membership. |
| S5 | **Transport: one `ScanHub` Durable Object per org and mode, raw WebSocket Hibernation API** (RT §0). Scans stay HTTP. The Worker publishes after the commit inside `waitUntil`; the scanner's own answer never waits. HTTP catch-up on the same ring buffer is the fallback. |
| S6 | **The server renders every audience; the hub only routes.** Per published scan the Worker renders at most three bodies: `customer` (a `ScanCustomerView`), `door` and `desk` (a `ScanMonitorRow`). A socket receives only the body for its audience. Customer bodies never carry a reason, a staff word, a note, a photo or another holder. |
| S7 | **A `customer` audience joins the display model** as an explicit opt-in: `scan.display.customer = { greet, chips, panel }`. Nothing a template author wrote reaches a Customer screen unless the doc names it there, and then only allow-listed row types over a customer scope (no `x-scan` inputs). Verdict copy is the system's `CUSTOMER_COPY`: every refusal and heads-up is **Please see the desk**. |
| S8 | **Display credentials are read-only.** A device in role `customer` or `monitor` fails `requireScanActor` with 403 `SCREEN_ONLY`: no resolve, act, lookup, undo, stats or recent scans. It may read its session, open the live socket, poll the catch-up and (monitors only) read a snapshot and audience-bound assets. |
| S9 | **Flip on the device.** A paired phone (`kind: device`) flips to Customer screen from its own menu (**Show to customer**), picking the scanner it faces. Flipping back to Scanner needs a staff PIN when the org has active staff. The server holds the role, so a customer holding the phone can't reach the scanner. |
| S10 | **Mode is per hub and per station.** Live and test never share a hub, a station or a screen. A device's mode change detaches it from its station. Test screens carry the Test band. |
| S11 | **Customer screens keep no history.** Customer bodies live in the hub for 30 s (enough for a reconnect inside a result's hold) and replay only if under 10 s old. Monitor bodies live 15 minutes or 500 events. D1 stays the record. |
| S12 | **Migration `0019_scan_stations.sql`** (additive: one table, four columns on `scanners`, one on `scans`). **Phase 0 change now:** widen `scanners.kind` and its CSRF check, and add `scanners.role`, so the guard refuses screens from day one (section 7). AX takes `0020`. |

---

## 1. Concepts

### 1.1 Device, kind, role

| Kind (ceiling) | Created as | Roles it can hold | Who changes the role |
| --- | --- | --- | --- |
| `device` | **Scanner** in the console, paired by code or **Pair here** | `scan`, `customer` | console any time; the device itself (S9) |
| `terminal` | **Till** (bearer token) | `scan` | nobody |
| `display` | **Customer screen** or **Desk monitor** in the console | `customer`, `monitor` | console only |

Why one table: pairing, the cookie, revocation, **Pair again**, expiry, `last_seen_at`, audit and the console list are
the same for a screen as for a scanner (one implementation per shared concept). A display row simply never accepts
templates or an event (`accepts` is null) and its staff columns stay null.

Why a kind as well as a role: the role is what the device shows now; the kind is what it may ever do from the device.
A phone left facing a customer is still a scanner underneath, so a PIN can bring it back. A counter iPad paired as a
screen can never scan, PIN or not; an admin changes it in the console.

### 1.2 Station

`scan_stations`: `name` ("Front desk", "Pool gate", "Till 1"), `mode`, and customer-facing settings:

| Setting | Default | Meaning |
| --- | --- | --- |
| `welcome` | **Hold up your pass** | Customer screen idle line, ≤ 40 |
| `refusedLine` | **Please see the desk** | every customer-facing refusal and heads-up, ≤ 40 |
| `greet` | true | "Hi, Maya" on ok and ready results |
| `showReady` | true | the desk card (`ready`) appears on the Customer screen ("Hi, Sam · Balance $42.50") |
| `showDraft` | true | an amount under review appears ("To pay $12.00") |

Members: any number of Scanners (`device`, `terminal`) and Customer screens; Desk monitors may also sit in a station
(for the station's presence list) but receive what their **watch** says (1.3). An admin session scanning ("Scan as
admin") belongs to no station.

Stations are optional. One phone at one door needs none; nothing is published for an org with no screens (5.4).

### 1.3 Watch (Desk monitors)

`MonitorWatchSchema`, exactly one of:

| Watch | Receives | Typical |
| --- | --- | --- |
| `{ station: true }` | its own station | the office iPad behind the front desk |
| `{ stationIds: [...] }` (1-8) | those stations | one monitor for three door stations |
| `{ eventId }` | every scan whose scanner is on that event | gala entrance overview |
| `{ zoneIds: [...] }` (1-8) | every scan in those zones (AX) | pool lifeguard station |
| `{ org: true }` | every scan in the org and mode | the manager's office |

The 8 cap comes from the hub's 10 tags per socket (RT §3; verified: 10 tags × 256 chars). A monitor also has an
**audience**, `door` or `desk` (default `desk`): the staff role its content is filtered for (DM §5.2). Never
`manager`: approvals and exports stay on scanners and in the console.

### 1.4 Every combination

| Setup | Station | Devices |
| --- | --- | --- |
| Two handhelds, one scanning, one facing the customer | "Pop-up" | phone A Scanner, phone B Customer screen (flipped on the device, or set in the console) |
| One or more handheld scanners plus a desk monitor | optional | scanners anywhere; monitor watches their station(s), event, zone or org |
| One scanner with a customer screen and a desk monitor | "Front desk" | scanner + Customer screen in the station; monitor `{ station: true }` in the same station or `{ stationIds }` from elsewhere |
| Several scanners feeding one desk monitor | one per door, or none | monitor `{ stationIds }`, `{ eventId }` or `{ org: true }` |
| One customer screen for two tills | "Counter" | Till 1, Till 2, one Customer screen |
| Two tills, a screen each | "Till 1", "Till 2" | one station per till |
| Terminal (POS) with an iPad facing the customer | "Till 3" | the terminal + a `display` Customer screen |

### 1.5 Edge cases

| Case | Behaviour |
| --- | --- |
| A Customer screen in a station with 2 scanners | Newest result wins. A result arriving while another is up interrupts it the way the scanner does (old card tucks 150 ms, new rises). The capsule names the scanner that scanned ("Till 2"). Results older than the one shown are dropped (ordering, 4.3). |
| A scanner "on two stations" | Not allowed: one station per device (S3). Two counters that must both show a scanner's results are one station with two Customer screens. Two monitors watching the same scanner is normal (S4). |
| A monitor across a whole event or zone | `{ eventId }` or `{ zoneIds }`. An event archived or a zone deleted leaves the watch empty: the monitor shows **Not set up** and the console flags it. |
| A Customer screen with no station, or a station with no scanner | Idle with the welcome line and a quiet **Not set up** chip; the console row says why. |
| A scanner flips to Customer screen and picks another scanner | It joins that scanner's station. If that scanner has none, a station named after it is created with both. Flipping back keeps the station. |
| Following itself, a terminal, a screen or a revoked device | Refused (`ROLE_NOT_ALLOWED`); the pick list never offers them. |
| A device changes mode | Detached from its station (`station_id = NULL`) in the same batch; sockets kicked (4409). |
| A station archived | Its devices detach; Customer screens show **Not set up**; monitors watching it lose that tag. |
| Two staff scan two customers at once at one screen | Physically ambiguous; the newest result shows with the scanner's name. The console suggests one station per till when a station has more scanners than screens and two scans land within 2 s more than 5 times a day (later; a hint, not a rule). |
| Monitor with `audience: door`, template input `x-scan: desk` | That value is absent from the monitor row and display, as on a Door scanner. |
| Admin "Scan as admin" | Publishes to org-wide and event monitors only (no station), audience bodies as for any scan. |

---

## 2. Credentials and permissions

### 2.1 What each role may do

| Route or capability | Scanner (`scan`) | Customer screen | Desk monitor | Notes |
| --- | --- | --- | --- | --- |
| `GET /scan/session` | yes | yes (`screen` block) | yes | |
| resolve, actions, undo, lookup, recent, stats, summary, roster, batch | yes | 403 `SCREEN_ONLY` | 403 `SCREEN_ONLY` | the guard (S8) |
| `GET /scan/live` socket | yes (presence, config, sends beats) | yes (customer bodies, beats, presence) | yes (monitor rows, presence) | |
| `GET /scan/live/events` catch-up | yes (presence only) | yes (customer rows < 10 s) | yes | |
| `GET /scan/live/snapshot` | no | no | yes | counters and the last 50 rows |
| `GET /scan/passes/{id}/assets/{name}` | yes (actor grant) | no | yes (audience grant, 2.4) | photos and thumbnails |
| `GET /scan/role/options`, `POST /scan/role` | `kind: device` only | `kind: device` only (to flip back) | no | S9 |
| `POST /scan/unpair` | yes | yes | yes | |
| Console (`/admin/scanning`) | admin session | | | unchanged: platform admin only (SA D3) |

### 2.2 What each role may see

| Content | Scanner | Desk monitor | Customer screen |
| --- | --- | --- | --- |
| Verdict, reason, reason sub | `SCAN_COPY` | `SCAN_COPY` | `CUSTOMER_COPY` (3.4): ok headline or **Please see the desk**; never a reason |
| Holder line | full | full | first name only, ok and ready only, when `greet` |
| Photo | per `display.photo.minRole` | same, for its audience | never |
| Meta line, chips, panels, notes | role-filtered (DM §5.2) | same for its audience | only what `display.customer` names, customer scope (3.2) |
| Staff note, event note, flags | yes | yes | never |
| Staff name, scanner name | yes | yes | scanner name in the capsule only ("Till 2") |
| Other holders | the last-scan strip | the feed | never: one result at a time, idle clears it |
| Values (before → after) | yes | per audience | only through an opted-in `progress` or `money` row, or the band ("+2 stamps", "Paid $12.00") |
| Counts | own today, event x of y | scope counters (visits today, in now, refused today) | never |

### 2.3 Revocation and changes

| Trigger | Server | Socket | Client |
| --- | --- | --- | --- |
| Revoke, unpair, idle or absolute expiry | token cleared (SA §2.7) | `hub.kick({ dev }, 4403)` | no reconnect; boot gate shows **Scanner removed** / **Pairing expired** |
| Role, station, watch, screen settings, mode changed (console or device) | row updated, `configRev` bumped | `hub.kick({ dev }, 4409)` | reconnect at once after refetching `GET /scan/session` |
| Station archived or renamed | members detached or renamed | `hub.kick({ st }, 4409)` | same |
| Org suspended | `isOrgActive` false | `hub.kickAll(4403)` from the orgs suspend hook (g, additive) | block panel **Organization suspended** |
| Session older than 12 h, or past token expiry | — | the hub closes 4401 on the next send or prune | reconnect; the upgrade re-runs auth |

Kicks run in `waitUntil` after the D1 batch. A missed kick is harmless: every upgrade and catch-up re-resolves the
cookie with no isolate cache (SA §2.7), and the 12 h attachment expiry bounds any socket.

### 2.4 Assets for monitors

A monitor row may carry a photo URL. Its grant is bound to the audience, not the actor:
`g = HMAC(derivedHmacKey(env, 'scan-asset'), 'aud:' ‖ orgId ‖ ':' ‖ mode ‖ ':' ‖ audience ‖ passId ‖ exp) ‖ exp`,
`exp` = now + 1 h. The asset route recomputes it for a monitor principal of that org, mode and audience (or higher).
Scanners keep their actor grant. Customer views carry no image URL at all.

### 2.5 Mode

The hub key is `${orgId}:${mode}`; the mode comes from the device row, never from the request. A station's mode is
fixed at creation; every member must share it (`STATION_MODE_MISMATCH`, 422). A test Customer screen shows the Test
band; a live screen can't follow a test scanner because they can't share a station.

---

## 3. The customer audience (display model addendum)

### 3.1 The doc block

```ts
// ScanDisplayDoc (DM §6.1) gains:
customer?: {
  greet?: boolean;          // default true: "Hi, {holder.firstName}" on ok and ready
  chips?: string[];         // ≤ 2 ids of header chips (base or variant) shown to the customer
  panel?: string | null;    // ≤ 1 panel id shown to the customer
};
```

No `customer` block means `defaultCustomer(doc)`: greet on, no chips, and the first panel whose `preset.id` is
`loyalty` or `balance` (the Stamp card's stamps, the Balance card's balance). Access card: AX's default doc sets
`customer: { chips: ['plan'], panel: null }`, so a member sees "Access granted · Pool" and their plan chip.

A panel shown to the customer keeps its normal staff rendering too; the block only points at it.

### 3.2 Rules

| Rule | Detail | Validator |
| --- | --- | --- |
| Allow-listed rows | `heading`, `field`, `big`, `columns`, `progress`, `money`, `chips`, `list`, `divider`; `history` only with `source: 'visits' \| 'value'` and `show ⊆ ['when', 'amount']`. Never `note`, `image` or a `history` with `where` or `action` | `SCAN_DISPLAY_CUSTOMER_ROW` (error) |
| No raised elements | the panel, its rows and items, and the named chips have no `minRole` | `SCAN_DISPLAY_CUSTOMER_ROLE` (error) |
| Customer scope | the Door scope minus every input with any `x-scan` annotation, minus the fields bound to them, minus `pass.externalId`, `scanner.*`, `event.arrived`, `event.expected`, `event.capacity`, `history.*.where` | `SCAN_DISPLAY_CUSTOMER_SCOPE` (error) when a named element reads a removed path |
| Density | 1 panel, ≤ 4 units (DM §1.6 weights); the customer type scale is larger | `SCAN_DISPLAY_CUSTOMER_DENSITY` (error) |
| References | ids must exist | `SCAN_DISPLAY_CUSTOMER_REF` (error) |
| Screens | `ready` and `ok` only. `heads_up` and `refused` show nothing from the doc | renderer |
| Safety | DM §1.11 rules 5, 6, 8, 9, 10, 11 apply unchanged | |

The editor's Scan screen mode (TD) gets a **Customer** tab beside Ready/OK/Heads-up/Refused: a preview at customer
scale and two pickers (chips, panel). Disallowed panels are greyed with the reason.

### 3.3 Rendered contract

```ts
// src/shared/contracts/scan-live.ts
ScanCustomerViewSchema = z.object({
  v: z.literal(1),
  screen: z.enum(['ready', 'ok', 'see_desk']),
  ref: UuidV7Schema,                                      // the request's idempotency key
  at: TimestampSchema,
  where: z.string().max(40),                              // the scanner's name, for the capsule
  band: z.object({ headline: z.string().max(28), sub: z.string().max(40).nullable() }),
  greet: z.string().max(24).nullable(),                   // "Hi, Maya"; null on see_desk
  chips: z.array(ScanChipSchema).max(2),
  panel: ScanDisplayPanelSchema.nullable(),               // DM §5.5, rendered over the customer scope
  lines: z.array(z.object({ icon: ScanIconSchema, text: z.string().max(40) })).max(2),
                                                          // system lines: "Until 9:00 PM today", "2 of 5 visits left" (AX)
  milestone: z.enum(['count', 'all_in', 'reward']).nullable(),
  test: z.boolean(),
}).strict();                                              // no pass id, scan id or reason: the screen can't correlate holders
```

`renderCustomerView(doc, scope, { screen, outcome, locale, timeZone, now })` is pure, in
`src/passkit/template/scan-display/customer.ts` (DS). The band and lines come from `CUSTOMER_COPY` and the outcome;
`greet`, `chips` and `panel` from the doc. On any throw: the system view (band only), log `SCAN_DISPLAY_RENDER`.

### 3.4 Customer copy (`src/shared/copy/scan-customer.ts`)

| Outcome | Headline | Sub |
| --- | --- | --- |
| idle | station `welcome` (**Hold up your pass**) | — |
| `reading` beat | **Checking…** | — |
| ok `check_in` | **Checked in** (event: **You're in**) | event name, else none |
| ok access grant (AX) | **Access granted** | zone name |
| ok `add` on a count | SCAN_COPY ("+2 stamps") | "9 of 10" |
| ok `add` on money | **Added $20.00** | — |
| ok `take` on money | **Paid $12.00** | — |
| ok `take` with `rewardLabel` | **Enjoy your reward** | reward label |
| ok `use_up` | **Redeemed** | — |
| ok `set` | **Updated** | — |
| milestone `reward` | **Reward ready** | "10 of 10" |
| `ready` (desk card) | **Hi, Sam** (greet), else **Hello** | template name ("Prepaid card") |
| `review` beat, money | **To pay $12.00** | **Balance after: $30.50** (client formatting from the ready view's money row) |
| `review` beat, count | **Adding 2 stamps** | — |
| every `heads_up` and `refused`, every mode mismatch, not found | station `refusedLine` (**Please see the desk**) | — |
| undone | back to idle | — |
| socket unhealthy | idle stays; chip **Reconnecting** | — |

The buddy: ok and ready play the existing beats; `see_desk` plays `sorry` (bow, look up), **never the head shake at a
customer** (the shake is staff-facing); `reading` plays the rummage lean-in (BM). Holds: ok 4 s, see_desk 6 s, ready
until the next event or 60 s, then idle with one wave.

### 3.5 Monitor row

```ts
ScanMonitorRowSchema = z.object({
  ref: UuidV7Schema, scanId: IdSchema.nullable(),        // null: a resolve-only outcome (desk refusal), not in D1
  at: TimestampSchema, st: IdSchema.nullable(),
  device: z.object({ id: IdSchema, name: z.string() }),  // the scanner, or { id: userId, name: 'Console' }
  staff: z.object({ name: z.string() }).nullable(),
  kind: ScanOutcomeKindSchema.exclude(['ready']), reason: ScanReasonSchema.nullable(),
  action: z.object({ id: z.string(), label: z.string(), kind: ScanActionKindSchema }).nullable(),
  direction: ScanDirectionSchema.nullable(), method: ScanMethodSchema,
  holder: z.string().max(40).nullable(),                 // display.identity.holder; null when unknown or another mode
  template: z.object({ name: z.string(), style: z.string() }).nullable(),
  value: ScanValueSchema.nullable(),                     // filtered for the audience
  zone: z.object({ id: IdSchema, name: z.string() }).nullable(),   // AX
  event: z.object({ id: IdSchema, name: z.string() }).nullable(),
  override: z.boolean(), undone: z.boolean(),
  display: ScanDisplaySchema.nullable(),                 // the outcome's display for this audience (row expand)
});
```

One builder, `toMonitorRow()` (`modules/scan/live/rows.ts`), serves both the live publish and the snapshot (from
`scans`), so the feed looks the same before and after a reload.

---

## 4. Realtime

### 4.1 Decision

RT's recommendation, adopted: `ScanHub`, one SQLite-backed Durable Object per `${orgId}:${mode}`, raw Hibernation
API, no framework; scans on HTTP; publish over DO RPC after the commit in `waitUntil`; HTTP catch-up as the fallback.
Verified against the docs (2026-11-05): `acceptWebSocket(ws, tags)` allows 10 tags of ≤ 256 chars and 32,768 sockets
per object; `serializeAttachment` holds ≤ 16,384 bytes and survives hibernation; `setWebSocketAutoResponse` answers
pings without waking the object; `evictDurableObject(stub, { webSockets: 'hibernate' })` and `runDurableObjectAlarm`
exist in `cloudflare:test` (present in the repo's `@cloudflare/vitest-plugin` 1.4.4 types).

Changes to RT, decided here:

| RT said | Here | Why |
| --- | --- | --- |
| Admin sessions may open desk sockets | Not in v1: only device cookies | A desk is a paired `display` device (RT §10.2's own recommendation). One principal, one revocation path |
| Terminals get a 60 s socket ticket | Not built | Terminals publish (their scans fan out) but never listen |
| Audiences `customer, door, desk, manager` | `customer, door, desk` plus `scan` (scanners get presence only) | Monitors cap at desk (1.3) |
| One ring buffer for all audiences, 15 min | Customer rows 30 s, replayed only if < 10 s old; staff rows 15 min / 500 | A customer screen must never show the previous customer after a reconnect (S11) |
| `beat` with `reading`/`idle` | adds `review` (amount under review) and `cancel` | The designer's **To pay** state |
| Desk ready not published | `ready` published to the station's Customer screens only, ephemeral | **Hi, Sam · Balance** before the charge |
| Station change and staff sign-out kick with 4403 | Config changes kick with **4409** (reconnect now); 4403 only for revoke, unpair, expiry and org suspension; staff sign-out kicks nothing | 4403 sends a device to the boot gate's block panel, wrong for a rename |
| `scan` event carries a `ScanDisplay` | carries `body`: a `ScanCustomerView` or a `ScanMonitorRow` (3.3, 3.5) | The feed needs verdict, where, who and when, not only the display |
| `st:none`, `org`, `zone:` tags on every socket | watch tags on monitors only (`w:org`, `w:st:`, `w:ev:`, `w:zn:`) | Scanners and Customer screens never receive org-wide traffic |
| Reset → `GET /scan/stats` | Reset → `GET /scan/live/snapshot` (monitors) or idle (Customer screens) | Stats are per actor; a monitor needs its scope |

### 4.2 Tags and fan-out

| Socket | Tags |
| --- | --- |
| Scanner | `dev:<id>`, `aud:scan`, `st:<stationId>` (if any) |
| Customer screen | `dev:<id>`, `aud:customer`, `st:<stationId>` |
| Desk monitor | `dev:<id>`, `aud:door` or `aud:desk`, then its watch: `w:st:<id>` (1-8), `w:ev:<id>`, `w:zn:<id>` (1-8) or `w:org` |

Publish `{ st, ev, zone, audiences }`:

```
targets = customers of st:<st>                 (body: audiences.customer)
        ∪ w:org ∪ w:st:<st> ∪ w:ev:<ev> ∪ w:zn:<zone>   (body: audiences[aud])
dedupe by socket; skip a socket whose body is missing
```

Tags and the attachment (`{ dev, name, org, mode, role, aud, st, watch, exp }`, < 1 KB) come from the D1 row at
upgrade, never from the query string.

### 4.3 Messages

```ts
// src/shared/contracts/scan-live.ts
LiveEventSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), epoch, seq, replayed: z.number().int(), presence: LivePresenceSchema.array() }),
  z.object({ t: z.literal('scan'), epoch, seq, at, st, ref, body: z.union([ScanCustomerViewSchema, ScanMonitorRowSchema]) }),
  z.object({ t: z.literal('undo'), epoch, seq, at, st, scanId: IdSchema }),
  z.object({ t: z.literal('ready'), at, st, ref, body: ScanCustomerViewSchema }),            // ephemeral
  z.object({ t: z.literal('beat'), st, dev: IdSchema, k: z.enum(['reading', 'idle', 'review', 'cancel']),
             ref: UuidV7Schema.nullable(), amount: z.number().nullable(), actionId: z.string().nullable() }), // ephemeral
  z.object({ t: z.literal('presence'), st: IdSchema.nullable(), devices: LivePresenceSchema.array() }),     // ephemeral
  z.object({ t: z.literal('reset'), epoch, seq }),
]);
LivePresenceSchema = z.object({ id: IdSchema, name: z.string(), role: ScreenRoleSchema, online: z.boolean() });
LiveClientMessageSchema = z.discriminatedUnion('t', [         // scanners only; anything else closes 1008
  z.object({ t: z.literal('beat'), k: z.enum(['reading', 'idle', 'review', 'cancel']),
             ref: UuidV7Schema.optional(), amount: z.number().finite().min(0).max(10_000_000).optional(),
             actionId: z.string().max(32).optional() }),
]);
LIVE_CLOSE = { expired: 4401, revoked: 4403, replaced: 4408, reconfigure: 4409 } as const;
```

`ping`/`pong` are raw strings answered by the auto-response. A beat is relayed only to the sender's station's
Customer screens; the hub caps beats at 10 per second per socket (close 1008 past it).

### 4.4 Ordering and dedupe

- `seq` is assigned in the hub (single-threaded, monotonic per hub); `epoch` changes when the hub's table is new.
- `ref` (the scan request's UUIDv7 idempotency key) identifies a result. Clients keep a 200-entry ref set and drop
  repeats (replay overlap, poll overlap).
- Replays (`replay: true` on the scan response, SA §7.2) never publish.
- Monitor feed order: `at` desc, then `seq`. A late arrival slots into place without moving the top row if it is
  older than the newest.
- Customer screen: shows an event only if its `at` ≥ the shown event's `at`; an older one is dropped. A `ready` for a
  `ref` is replaced by that `ref`'s `scan`. `review` and `cancel` beats apply only to the `ready` with the same `ref`.
- `undo { scanId }`: monitors mark the row undone; a Customer screen showing that scan returns to idle.

### 4.5 Reconnect and replay

| Client | On connect | Gap too big (epoch changed, or since < the oldest seq − 1) |
| --- | --- | --- |
| Desk monitor | `?since=<seq>&epoch=<epoch>`: the hub replays its audience's rows for its watch, then `hello { replayed }` | `reset` → `GET /scan/live/snapshot` |
| Customer screen | the same query; the hub replays only customer rows younger than 10 s | `reset` → idle |
| Scanner | presence only | — |

Heartbeat and resume as RT §6.5: ping every 20 s while visible, reconnect after 8 s without pong, ping on
`visibilitychange`, `pageshow` and `online` and reconnect after 2 s without pong, backoff 0.5 → 10 s with jitter.
While unhealthy: the catch-up poll `GET /scan/live/events?since&epoch` every 2 s for 2 min, then 5 s; the chip
**Reconnecting** appears after 2 s unhealthy (no layout shift). Screens hold a Screen Wake Lock and re-request it on
every `visible`; refused → a small **Keep this screen on** chip (RT §4).

### 4.6 Latency

Target: **scan request start → Customer screen paint p95 ≤ 300 ms** on venue Wi-Fi; the `reading` beat (sent at
decode, before the request) lands in ≤ 100 ms so the buddy leans in while the server works.

| Step | Budget |
| --- | --- |
| Scanner request → D1 commit | ≤ 130 ms (inside SA §13.1's 150 ms p95) |
| Render the extra audiences (≤ 3, pure, data already loaded) | ≤ 5 ms |
| Worker → hub RPC (hub near the venue) | 5-30 ms |
| Hub insert + fan-out | 1-5 ms |
| Hub → screen socket | 10-40 ms |
| Screen paint (card rise starts) | 1 frame |
| **Total** | **≈ 160-220 ms** |

Measured in e2e locally (assert < 300 ms between the scanner's request start and the screen's `data-ref` change) and
on devices before release (PL §8.2 gains this row).

### 4.7 Cost

RT §5 stands (≈ $0.30 a month platform-wide, ≈ $0 idle). The additions are free or tiny: outgoing messages cost
nothing, the extra renders are CPU inside the existing request's `waitUntil`, and publishing is skipped entirely when
the org and mode has no screen (5.4), so single-phone orgs pay nothing. Catch-up polling runs only while a socket is
unhealthy and steps down (2 s → 5 s), as RT warns.

### 4.8 Auth on connect

`GET /api/v1/scan/live` (`routes-live.ts`):
1. `Upgrade: websocket`, else 426 `UPGRADE_REQUIRED`.
2. `Origin` equals `PUBLIC_BASE_URL` (or the legacy origin while both serve), else 403 `LIVE_ORIGIN`.
3. `requireLivePrincipal()`: the scanner cookie only (`ScannerStore.resolve`, no isolate cache); not revoked, not
   expired, org active. Bearer and sessions get 401 `SCANNER_UNAUTHENTICATED`.
4. `RL_SCAN` on `actorKey`.
5. `live.identify(ctx, row)` builds the attachment (audience, tags, `exp = min(token expiry, now + 12 h)`).
6. Forward to `SCAN_HUB.getByName(org:mode)` with the attachment in `x-pb-live`; the hub is not routable from
   outside, so it trusts the header. It keeps ≤ 3 sockets per device and closes the oldest with 4408.

No CSRF on the socket: the only client message is a beat, which changes nothing stored.

### 4.9 Hibernation

The hub holds no timers. It hibernates 10 s after its last event; pings never wake it. It wakes for a publish, a
beat, a connect or close, and the prune alarm (hourly while rows exist, not re-armed when empty). All per-socket state
is the attachment; the constructor re-reads `epoch` and `seq` from SQLite inside `blockConcurrencyWhile`.

### 4.10 Wrangler and migration (integration owns the files)

```jsonc
// wrangler.jsonc
"durable_objects": { "bindings": [{ "name": "SCAN_HUB", "class_name": "ScanHub" }] },
"migrations": [{ "tag": "v1", "new_sqlite_classes": ["ScanHub"] }]
```

`src/worker/index.ts`: `export { ScanHub } from './modules/scan/live/hub.ts';`. Then `npm run gen` for
`worker-configuration.d.ts`. `vite dev` (Cloudflare plugin) and the worker test pool pick the binding up from
`wrangler.jsonc`; no extra config. `tools/wrangler-config.test.ts` asserts the binding and the migration tag.

### 4.11 Local dev and tests

- `npm run dev` runs the hub in workerd; two browser windows (a scanner and a screen paired with **Pair here** in
  two profiles) show the round trip.
- Worker tests use `SELF.fetch` with `Upgrade: websocket` and the response's `webSocket` (`accept()` it in the test),
  `env.SCAN_HUB.getByName()` for RPC, `runInDurableObject` to inspect rows, `evictDurableObject(stub, { webSockets:
  'hibernate' })` for hibernation, `runDurableObjectAlarm` for pruning. Per-file storage isolation keeps hubs apart.
- e2e: Playwright contexts on `vite dev` (section 6.6).

### 4.12 Failure modes

| Failure | Scanner | Customer screen | Desk monitor |
| --- | --- | --- | --- |
| Hub unreachable, publish throws | unaffected (`waitUntil`, caught, `scan.live.publish_failed`, code `LIVE_PUBLISH`) | misses that result; stays idle or on the last one until its hold ends | catches up via `reset` → snapshot on reconnect, or the 5-min resync |
| Socket drops (Wi-Fi, iOS lock) | unaffected; the `reading` beat is skipped | **Reconnecting** chip after 2 s; welcome stays; catch-up poll | **Reconnecting** chip; catch-up poll; replay on reconnect |
| Hub wiped or moved (new epoch) | — | `reset` → idle | `reset` → snapshot |
| D1 down | scans fail as today | idle | snapshot fails: the feed keeps what it has and says **Can't load older scans** |
| Revoked mid-shift | 401 on next scan | 4403 → block panel | 4403 → block panel |
| Two tabs on one device | — | the oldest socket closes 4408: **Open on another tab** | same |
| Clock skew on devices | — | none: `at` is server time | none |

---

## 5. Server flow

### 5.1 Who publishes what

| Request | Publishes | To |
| --- | --- | --- |
| `POST /scan/actions` → ok, heads_up, refused (not a replay) | `scan` with the bodies present | customers of its station, matching monitors |
| `POST /scan/resolve` → `ready` | `ready` (customer body), if the station has a Customer screen and `showReady` | customers of its station |
| `POST /scan/resolve` → heads_up, refused | `scan` (`scanId: null`) | as actions |
| undo (device or console) | `undo` | customers of the station, matching monitors |
| batch (v2 offline) | `scan` per item, `at` = server time, customer body omitted | monitors only (a late result must not reach a customer screen) |

### 5.2 Rendering the audiences

`live/audiences.ts`, called from `outcome.ts` with the data the response already loaded:

1. `actor.live` (loaded by the guard, 5.4) lists what exists: `customers: boolean` (Customer screens in its station),
   `monitorAudiences: ('door' | 'desk')[]`.
2. `needs` = the union of the compiled needs for the actor's role, the monitor audiences present and the customer
   block, so history statements ride in the existing batch (DM §5.3: statements, never round trips).
3. After the response is built, in `waitUntil`: render `desk`/`door` displays (DS `buildDisplay` per role) →
   `toMonitorRow`; render `renderCustomerView` → publish. Each render is guarded; one failure drops that audience
   only.

### 5.3 The publish call

```ts
// live/publish.ts
export function publishScan(ctx: ServiceContext, actor: ScanActor, result: CommittedResult): void;
export function publishReady(ctx: ServiceContext, actor: ScanActor, card: ScanCard, ref: string): void;
export function publishUndo(ctx: ServiceContext, scan: { orgId; mode; stationId; eventId; zoneId; id }): void;
export function kick(ctx: ServiceContext, orgId: string, mode: Mode, match: { dev?: string; st?: string; all?: true }, code: LiveCloseCode): void;
```

Each starts `ctx.waitUntil`, catches, logs `scan.live.*` with `orgId` and `code` only.

### 5.4 Nothing to publish, nothing spent

The guard's scanner query gains two scalar subqueries (no extra round trip):
`EXISTS (SELECT 1 FROM scanners WHERE station_id = s.station_id AND role = 'customer' AND revoked_at IS NULL)` and
`(SELECT group_concat(DISTINCT json_extract(screen, '$.audience')) FROM scanners WHERE org_id = s.org_id AND mode =
s.mode AND role = 'monitor' AND revoked_at IS NULL)` (index `scanners_org_role`). Both false or empty: no render, no
RPC. A test counts `SCAN_HUB` calls: 0 for an org without screens.

---

## 6. Pairing and role flows

### 6.1 Add a device (console)

Scanning › **Devices** › **Add device**:
1. **What is it?** Scanner · Customer screen · Desk monitor · Till.
2. Scanner: accepts (event or templates) and settings as today (SA §2.2), optional station. Customer screen: station
   (pick, or **New station** inline: name). Desk monitor: **Watch** (This station · Stations · Event · Zones · Everything)
   and **Shows** (Door · Desk).
3. Pairing face (unchanged component, `pairing-face.tsx`): QR of `/scan#pair=…` and the code; **Pair here** for the
   device in front of the admin.
4. On the device, the confirm card names the role: **Pair as Customer screen** · **Front desk** · **Northside Gym**
   (`ScanPairPreview` gains `role` and `stationName`). **Pair**.
5. `/scan` boots, reads `GET /scan/session`, and the role gate renders the face: scanner, customer or monitor. Each
   face is a lazy chunk of the same `scan.html`.

The console's Devices list groups by station (Stations are group headers with **New station**, rename, settings,
archive); unassigned devices sit under **No station**. Each row: role icon, name, online dot, follows/watch summary.
Changing role, station or watch is a row action; the device follows within a second (4409).

### 6.2 Flip a phone into a Customer screen (device)

Scanner menu › **Show to customer** (hidden when `customerToggle` is off, for terminals and for admin sessions):
1. Sheet **Which scanner is it facing?**: this station's scanners first, then the org's other online scanners in this
   mode (`GET /scan/role/options`); never itself.
2. Pick → `POST /scan/role { role: 'customer', followScannerId }` (CSRF). The server joins the station (or creates
   one named after that scanner), sets the role, audits `scanner.role_change` (`via: 'device'`), kicks with 4409.
3. The device swaps to the customer face without a reload; the scanner it faces shows a quiet chip **Customer screen
   on** (presence).

### 6.3 Back to scanning (device)

Press and hold the capsule for 1 s → sheet **Back to scanning?**:
- The org has active staff: **Staff PIN** (any active staff member, any role). `POST /scan/role { role: 'scan',
  unlock: { staffId, pin } }`. Same lockout counters as SA §2.7 (`scan:pin:*`, `scan:pinall:*`). With staff sign-in on,
  the unlocking staff member is signed in.
- No active staff: the hold alone (2 s, with a ring filling). The console marks the device **Anyone can switch it
  back** and suggests adding staff.
Then the scanner face returns in its station.

### 6.4 State machine (device row)

```
            console: role/station/watch                       device: Show to customer
 scan ─────────────────────────────────▶ customer  ◀─────────────────────────── scan (kind device)
  ▲                                         │
  └──────── device: hold + PIN (or hold) ───┘   console: any role allowed by the kind, no PIN
 display rows: customer ⇄ monitor (console only); revoke/unpair from any state (SA §7.1)
```

---

## 7. Data model, contracts, routes, layout, tests

### 7.1 Phase 0 amendment to `0014_scan.sql` (now, before it merges)

```sql
  kind TEXT NOT NULL CHECK (kind IN ('device', 'terminal', 'display')),
  -- what the device does now; a display never scans, a terminal never stops scanning
  role TEXT NOT NULL DEFAULT 'scan' CHECK (role IN ('scan', 'customer', 'monitor')),
  ...
  CHECK (kind <> 'terminal' OR csrf_secret IS NULL),
  CHECK (kind <> 'terminal' OR role = 'scan'),
  CHECK (kind <> 'display' OR role <> 'scan')
```

Both CHECKs sit on `CREATE TABLE scanners`; changing them after merge means rebuilding `scanners`, which has a child
(`scanner_templates`). **Fallback if 0014 has already merged:** no rebuild either way; `0019` adds
`role TEXT NOT NULL DEFAULT 'scan' CHECK (role IN (...) AND (kind <> 'terminal' OR role = 'scan'))` and
`screen_only INTEGER NOT NULL DEFAULT 0 CHECK (screen_only IN (0, 1) AND (screen_only = 0 OR (kind = 'device' AND
role <> 'scan')))`, and screens are `kind: device` with `screen_only = 1` (SQLite checks an added column's
cross-column CHECK against existing rows; verified on 3.54).

### 7.2 `migrations/0019_scan_stations.sql`

Additive; touches no table rebuild; independent of AX's `0020`.

```sql
-- Stations (a counter or door: scanners and customer screens), device placement, monitor watch, station on scans.

CREATE TABLE scan_stations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  name TEXT NOT NULL,
  settings TEXT NOT NULL CHECK (json_valid(settings)),   -- ScanStationSettingsSchema
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE UNIQUE INDEX scan_stations_org_name ON scan_stations (org_id, mode, name COLLATE NOCASE) WHERE archived_at IS NULL;
CREATE INDEX scan_stations_org ON scan_stations (org_id, mode, id DESC);
CREATE INDEX scan_stations_created_by ON scan_stations (created_by);

ALTER TABLE scanners ADD COLUMN station_id TEXT REFERENCES scan_stations (id) ON DELETE SET NULL;
-- MonitorWatchSchema; monitors only
ALTER TABLE scanners ADD COLUMN watch TEXT CHECK (watch IS NULL OR (json_valid(watch) AND role = 'monitor'));
-- ScreenSettingsSchema: monitors { audience, alerts, sound }; null otherwise
ALTER TABLE scanners ADD COLUMN screen TEXT CHECK (screen IS NULL OR json_valid(screen));
CREATE INDEX scanners_station ON scanners (station_id, role) WHERE station_id IS NOT NULL;
CREATE INDEX scanners_org_role ON scanners (org_id, mode, role) WHERE revoked_at IS NULL;

-- The station a scan came from, for the monitor snapshot and the Scans log filter. Not a foreign key (SA 6.1).
ALTER TABLE scans ADD COLUMN station_id TEXT;
CREATE INDEX scans_station ON scans (station_id, at DESC) WHERE station_id IS NOT NULL;
```

Rules: `scanners.station_id` must share the device's org and mode (service check, `STATION_MODE_MISMATCH`); archive
sets `archived_at` and detaches members in one batch; `test/migrations.test.ts` gets `describe('0019_scan_stations')`
(table, columns, the FK-child index test, the watch CHECK, the partial index); `test/query-plans.test.ts` covers the
snapshot, the station list with member counts and the guard's subqueries. Retention: none new (`scans` keeps its).

Checked on SQLite 3.54 against `next/n8-p0` (`ba49994`): 0001-0016 with A1 applied, then this file, apply cleanly; a
display with `role = 'scan'`, a terminal with `role = 'customer'` or a CSRF secret, and a watch on a non-monitor are
rejected; deleting a station nulls `station_id`; the guard's two subqueries use `scanners_station` and
`scanners_org_role`, the snapshot uses `scans_station`. The fallback path (unamended 0014 plus `role` and
`screen_only` columns) applies and rejects `screen_only = 1` on a scanning row.

### 7.3 Contracts

| File | Owner | Names |
| --- | --- | --- |
| `contracts/scan-live.ts` (new) | P0 lead (after P0: ST) | `ScreenRoleSchema`, `ScanStationSettingsSchema`, `ScanStationSchema`, `CreateScanStationSchema`, `UpdateScanStationSchema`, `ScanStationListQuerySchema`, `ScanStationAssignSchema`, `MonitorWatchSchema`, `ScreenSettingsSchema`, `ScanRoleChangeSchema` (`{ role: 'customer', followScannerId }` \| `{ role: 'scan', unlock?: ScanApprovalSchema }`), `ScanFollowOptionsSchema`, `ScanCustomerViewSchema`, `ScanMonitorRowSchema`, `LivePresenceSchema`, `LiveEventSchema`, `LiveClientMessageSchema`, `LiveCatchUpSchema` (`{ epoch, seq, events } \| { reset: true }`), `ScanLiveSnapshotSchema` (`{ epoch, seq, counts: { visitsToday, refusedToday, inNow: int \| null }, rows: ScanMonitorRow[] ≤ 50, presence }`), `LIVE_CLOSE` |
| `contracts/scanners.ts` | P0 now (7.6) | `ScannerKindSchema` + `display`; `ScannerSchema.role`, `.accepts` nullable; later additive: `.station`, `.watch`, `.screen` |
| `contracts/scan.ts` | P0 now / later | now: `ScanSession.scanner.kind` + `display`, `.role`; later additive: `ScanSession.screen` (`{ role, station, welcome, refusedLine, greet, showReady, showDraft, watch, audience, alerts, sound } \| null`), `ScanSession.live` (`{ on: boolean }`), `ScanPairPreview.role`, `.stationName`; `ScannerSettings.customerToggle` (default true) |
| `passkit/template/scan-display/schema.ts` | P0 now (cheap) | `ScanDisplayDoc.customer` optional |
| `copy/scan-customer.ts` (new) | ST | `CUSTOMER_COPY` (3.4) |
| `copy/scan.ts` | P0 | `SCREEN_ONLY`, `ROLE_NOT_ALLOWED`, `STATION_MODE_MISMATCH`, `UNLOCK_REQUIRED` copy |

### 7.4 Routes

Device API (`/api/v1/scan`), guard in brackets:

| Method and path | Guard | Body or query → result |
| --- | --- | --- |
| `GET /live` | live principal, Origin, `RL_SCAN` | `?since&epoch` → 101 |
| `GET /live/events` | live principal | `?since&epoch` → `LiveCatchUp` |
| `GET /live/snapshot` | live principal, role `monitor` | → `ScanLiveSnapshot` |
| `GET /role/options` | scanner principal, `kind: device` | → `ScanFollowOptions` (`{ items: { id, name, stationName, online }[] ≤ 50 }`) |
| `POST /role` | scanner principal, `kind: device`, CSRF, `RL_SCAN` | `ScanRoleChange` → `ScanSession` |
| `GET /session` | any device role (exempt from `SCREEN_ONLY`) | → `ScanSession` with `screen` and `live` |
| everything else | `requireScanActor` | refuses `role ≠ scan` with 403 `SCREEN_ONLY` |

Console (`requireAdmin`, CSRF, mode from the header, org asserted):

| Method and path | Notes |
| --- | --- |
| `GET`, `POST /api/v1/scan-stations` | list with member counts and online; create |
| `GET`, `PATCH /api/v1/scan-stations/{id}` | name, settings; kicks members (4409) |
| `POST /api/v1/scan-stations/{id}/archive` | detaches members, kicks |
| `POST /api/v1/scan-stations/{id}/devices` | `{ scannerIds ≤ 50 }`: moves them in (mode checked), kicks |
| `POST /api/v1/scanners` | `kind: 'display'` + `role` + `stationId` / `watch` + `screen`; returns a pairing |
| `PATCH /api/v1/scanners/{id}` | adds `stationId`, `watch`, `screen` |
| `POST /api/v1/scanners/{id}/role` | `{ role, stationId?, watch? }`, any role the kind allows, no PIN; audited |
| `GET /api/v1/scans?stationId=` | filter (additive) |

Errors: `SCREEN_ONLY` 403, `ROLE_NOT_ALLOWED` 422, `STATION_MODE_MISMATCH` 422, `STATION_ARCHIVED` 422,
`UNLOCK_REQUIRED` 403, `PIN_INVALID` 400 (existing), `LIVE_ORIGIN` 403, `UPGRADE_REQUIRED` 426. Audit:
`scan_station.create`, `.update`, `.archive`, `.assign` (user); `scanner.role_change` (user or scanner; `detail`:
`from`, `to`, `stationId`, `via`, `unlockedBy`), `scanner.watch_change` (user).

### 7.5 Module and file layout

```
src/worker/modules/scan/                         ST (new stream) unless noted
  routes-stations.ts     /api/v1/scan-stations/* (scanStationsRoutes)
  routes-live.ts         /scan/live, /live/events, /live/snapshot
  routes-role.ts         /scan/role, /scan/role/options
  stations.ts            station service: CRUD, assign, archive, mode rule, implicit station on flip
  role.ts                role changes (device and console), unlock, kicks
  repo-stations.ts       SQL for stations and placement
  live/hub.ts            ScanHub (DurableObject): fetch, publish, read, kick, kickAll, webSocketMessage/Close, alarm
  live/hub-sql.ts        hub schema, insert, replay, prune (the only SQL in the hub)
  live/tags.ts           pure: tagsFor(who), targetsFor(evt), watchTags(watch)
  live/identify.ts       the attachment from a device row
  live/audiences.ts      renders customer and monitor bodies (calls DS)
  live/rows.ts           toMonitorRow (live and snapshot)
  live/publish.ts        publishScan, publishReady, publishUndo, kick
  live/snapshot.ts       counters and last 50 rows from D1
  live/guard.ts          requireLivePrincipal
src/passkit/template/scan-display/customer.ts   DS: renderCustomerView, customerIssues, defaultCustomer
src/shared/contracts/scan-live.ts                P0 lead, then ST
src/shared/copy/scan-customer.ts                 ST
src/web/scan/live/                               ST: socket.ts, use-live.ts, live-store.ts (dedupe, order, counters), wake.ts
src/web/scan/boot/role-gate.tsx                  UI: picks the face from the session
src/web/scan/customer/                           UI: customer-app, customer-card, idle, see-desk, customer.css
src/web/scan/monitor/                            UI: monitor-app, feed, feed-row, counters, filters, alert, monitor.css
src/web/scan/role/                               UI: flip-sheet, unlock-sheet
src/web/admin/scanning/devices/, stations/       AD: Devices tab, Add device steps, station groups and settings
src/web/admin/templates/designer/scan/customer-tab.tsx   TD
```

Every file under 300 lines. The visual direction stays in UI and BU (PL §3): ST's client files carry state, not
geometry. The customer and monitor faces are lazy chunks; the scan initial budget (150 kB) gains only `socket.ts`
and `use-live.ts` (≈ 3 kB).

Shared touches (additive, reported): SV `guard.ts` (`SCREEN_ONLY`, `actor.live`, `actor.station`), `outcome.ts`,
`act.ts`, `undo.ts` (publish calls), `auth-store.ts` (role); SC `scanners.ts`, `routes-scanners.ts`, `pairing.ts`
(preview fields), `feed.ts` (`stationId` filter), `dto-console.ts`; DS `display.ts` (`buildCustomerView`, union
`needs`); `modules/orgs` suspend hook (g); `wrangler.jsonc`, `src/worker/index.ts`, `src/worker/app.ts` (integration);
`assets.ts` (audience grants).

### 7.6 Tests

**Worker** (`vitest-pool-workers`, `makeEnv()`):
- Isolation: an org A monitor and Customer screen receive nothing when org B scans; a test-mode screen receives nothing
  from a live scan of the same org; a Customer screen of station X receives nothing from station Y; a monitor with
  `{ stationIds: [X] }` gets X only; `{ eventId }` and `{ zoneIds }` route by the scan's event and zone; `{ org: true }`
  gets all, each event once even when several tags match.
- Customer safety: for every outcome fixture (each reason, mode mismatch, not found) the customer body has
  `screen: 'see_desk'`, the station's `refusedLine` and no `reason`, `staff`, `notes`, `photo`, `holder` beyond the
  first name, or `passId` (a recursive key and value scan against the fixture's holder data); an opted-in panel whose
  row binds an `x-scan: desk` input renders that row empty; a doc without `customer` shows the Stamp card's stamps and
  nothing else; `greet: false` gives no name.
- Monitor audience: a `door` monitor's row and display omit desk-only inputs; photos carry an audience grant that a
  scanner of another org can't use.
- Guard: a `customer` or `monitor` device gets 403 `SCREEN_ONLY` on resolve, actions, undo, lookup, scans, stats,
  summary and assets (customer); `GET /scan/session` works.
- Roles: device flip to customer joins or creates the station, audits, kicks 4409; flip back needs a PIN when staff
  exist (`UNLOCK_REQUIRED`), locks after 5 misses; a terminal or display can't flip (`ROLE_NOT_ALLOWED`); following
  itself, a screen, a revoked or another-mode device is refused; a mode change detaches the station.
- Hub: replay since/epoch; customer rows older than 10 s never replay; `reset` on a new epoch; eviction with
  `webSockets: 'hibernate'` keeps sockets and attachments; prune alarm; 4 sockets from one device closes the oldest
  4408; a beat from a customer socket closes 1008; a 4401 on an expired attachment.
- Publish: once per non-replay scan; none for replays; none when the org has no screens (`SCAN_HUB` spy: 0 calls); a
  throwing hub never fails the scan or changes its response bytes.
- Upgrade: no cookie 401; wrong Origin 403; revoked 401; bearer 401; admin session 401.

**Unit:** `tags.ts` targets per watch; `live-store` dedupe by ref, order by `at`, customer newest-wins and
ready/review pairing, counters; `CUSTOMER_COPY` covers every outcome and reason; `renderCustomerView` allow-list,
caps, density and fail-safe; `customerIssues` codes.

**Web** (jsdom, `vitest-axe`): customer and monitor faces in light and dark, reduced motion, the **Reconnecting** chip
without layout shift, the alert's live-region announcement, flip and unlock sheets.

**e2e** (`e2e/17-stations-*.spec.ts`, IN): scanner + Customer screen contexts, scan → screen shows the card in
< 300 ms locally; scanner + monitor + screen, three scans in order; kill the screen's socket, scan twice, reconnect:
the monitor shows both, the screen stays idle; flip a phone to customer and back with a PIN; revoke a screen in the
console: its block panel appears within 2 s.

---

## 8. Phase 0 amendments

### Now (P0 is mid-build; each is small and avoids a rebuild or a frozen-contract break later)

| # | Where | Change |
| --- | --- | --- |
| A1 | `migrations/0014_scan.sql` + `test/migrations.test.ts` | `kind` adds `display`; the CSRF CHECK becomes `kind <> 'terminal' OR csrf_secret IS NULL`; add `role` with its two CHECKs (7.1). Tests: a display with `role = 'scan'` and a terminal with `role = 'customer'` are rejected |
| A2 | `platform/auth.ts` (foundation) | `ScannerAuth.role: 'scan' \| 'customer' \| 'monitor'` and `ScannerAuth.scannerKind`; `ScannerStore.resolve` returns them |
| A3 | `modules/scan/guard.ts` (P0.4) | `requireScanActor` refuses `role ≠ 'scan'` with 403 `SCREEN_ONLY`, after the credential step; exempt `GET /scan/session` and `POST /scan/unpair`. Test with `fake.scanner({ role: 'customer' })` |
| A4 | `test/helpers/fake-auth.ts` | `fake.scanner({ role?, kind? })` |
| A5 | `contracts/scanners.ts`, `contracts/scan.ts` | `ScannerKindSchema` + `display`; `ScannerSchema.role`; `ScannerSchema.accepts` nullable (null only for `display`, a refine on create); `ScanSession.scanner.kind` + `display`, `.role` |
| A6 | `copy/scan.ts` | `SCREEN_ONLY`: **This device is a screen.** · **Ask an admin to change it.** |
| A7 | `passkit/.../scan-display/schema.ts` | optional `customer: { greet?, chips? ≤ 2, panel? }` on the strict doc schema, so blueprints can ship it |

### Later (additive, with `0019` and stream ST)

Everything else: the stations table and columns, `scans.station_id`, `contracts/scan-live.ts`, the session's `screen`
and `live` blocks, `ScanPairPreview.role`/`stationName`, `ScannerSettings.customerToggle`, the hub binding and
migration, routes, publish calls, the customer renderer, `CUSTOMER_COPY`, the console's Devices tab, the faces. No
frozen contract is renamed or narrowed by any of it.

Note for P0.5: keep `connect-src 'self'` in the `/scan` CSP (CSP Level 3 matches same-origin `wss:`); add a device
check [U] on iOS 17+ Safari and home-screen mode. If it fails, add explicit `wss://passbook.mobile
wss://wallet.plrs.im` in both `_headers` and `scanContentSecurityPolicy()`.

---

## 9. Build plan (stream ST)

| Task | Milestone | Depends on | Delivers |
| --- | --- | --- | --- |
| ST.1 | after M1 | P0 + A1-A7, SV guard | `0019`, stations service and routes, console role/station/watch on scanners, `SCREEN_ONLY` exemptions, audit |
| ST.2 | M2 | ST.1, integration binding | `ScanHub`, `routes-live`, catch-up, snapshot, tags, kicks, hub tests |
| ST.3 | M2 | ST.2, DS customer renderer | publish from act/resolve/undo, audiences, `toMonitorRow`, union needs, zero-publish rule |
| ST.4 | M3 | ST.2 | client `socket.ts`, `live-store`, wake lock; role gate (UI); customer and monitor faces (UI, BU beats) |
| ST.5 | M3 | ST.1, ST.4 | device flip and unlock (server + sheets) |
| ST.6 | M3 | ST.1 | console Devices tab and Add device steps (AD) |
| ST.7 | M4 | all | e2e 17, device checks (latency, iOS lock and resume, wake lock), `docs/operations.md` hub runbook (kick, wipe) |

AX (zones) lands independently; monitors gain `{ zoneIds }` and publishes carry `zone` when AX's `scans.zone_id`
exists. Until then the zone watch is hidden in the console.

---

## 10. For the owner

1. **Unlocking a phone that faces customers** takes a staff PIN (any staff member). Without staff set up, a 2-second
   hold unlocks it, and the console says so. Fine, or should the toggle require staff?
2. **The customer screen greets by first name** ("Hi, Maya") on a granted or paid result. On a stolen pass that shows
   the real holder's first name to the person holding it. The alternative is no name at all. Keep the name?
