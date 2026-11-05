# Scanner architecture

The one design for PassBook's scanner: access, server and client. Status: decided, ready to build. 2026-11-04.

> **Revision 2026-11-05** (the owner's two new requirements: multi-screen stations and the Access card):
> - **Stations, screens and realtime** (new section 18, D27-D31). Every paired thing stays a `scanners` row with a
>   **kind** (`device`, `terminal`, new `display`) and a **device role** (`scan`, `customer`, `monitor`). A station
>   groups the scanners and Customer screens at one counter; Desk monitors watch a scope. Results reach screens through
>   one `ScanHub` Durable Object per org and mode (WebSocket Hibernation, HTTP catch-up), published after the D1 commit
>   in `waitUntil`. The server renders a separate, customer-safe `ScanCustomerView`. 13.1's "No Durable Object" is
>   amended: counts stay in D1; the hub only pushes and replays.
> - **Access cards and zones** (new section 19, D32-D36). Access is a policy on a template (`scan.access`), not a new
>   action kind: unlimited **Access granted**, never "already checked in". Plans (24/7, Timed, Guest) on the template,
>   one per pass; zones are org data, nested, checked by scanners (0-8). Five new red reasons. 2.6 gains steps
>   10a-10e and the access gate at 15.
> - **Guard order** (2.5): a device-role step after the rate limits refuses screens with 403 `SCREEN_ONLY`.
> - **Migrations:** `0014` takes the device kind and role now (`addendum/p0-amendments.md`); `0019_scan_stations.sql`
>   and `0020_scan_access.sql` follow, additive.
> - **Detail references:** `addendum/stations.md` (**ST**), `addendum/access.md` (**AX**),
>   `addendum/cloudflare-realtime.md` (**RT**). This file summarizes them and wins where they differ; section 1 lists
>   the conflicts (rows marked 11-05).

> **Revision 2026-11-04** (the owner's three changes):
> - **Result content is template data.** New section 4.6 adds the scan display: `scan.display` in the manifest
>   (`ScanDisplayDoc`), the rendered `ScanDisplay` contract on `ScanCard` and `ScanOutcome`, the pure server renderer,
>   role filtering before evaluation, the binding scope, and scan history computed from `scans` (one new index, no
>   new table). `scan.values` and `scan.identity` are removed; `ScanCard.photoUrl` and `identityFields` move into
>   `display.identity`. Decisions D21-D26, conflicts in section 1.
> - **No per-event display.** Events keep check-in logic plus an optional staff note (`scan_events.note`, ≤ 140).
> - **Display-only template versions activate on save** without a reissue (`template_versions.build_key`, migration
>   `0018_templates_build_key.sql`; `SaveVersionRequest.activate: 'display-only'`).
> - **Client loop for B strengthened** (7.5): the camera stays live during results, a card layer rises from the
>   buddy's pass and tucks back, a different code is accepted from T0 + 350 and interrupts the card, desk `ready`
>   renders as a panel with a system action area, the buddy has one seat on the dock.
> - **Budgets** (13.2): the `result` chunk now holds the card layer, the display rows and 40 icons; the full pass view
>   moves behind the chevron; the buddy gets an XL tier and a `card` prop.
> - **Ownership** (16): the display (passkit `scan-display/**`, `modules/scan/{display,repo-history}.ts`) and the
>   designer's Scan screen mode join n8.
> - **Review fixes** (DM R15-R19): the density budget counts the header per screen and the renderer cuts the rest; the
>   band title is a literal (widened to the holder's name by the owner answers below); URL inputs, contact- and secret-named inputs and fields that reference `pass.*` are out
>   of scope; mode mismatches show only `ScanOutcome.template.name`; the store card ships Balance (now the **Balance card**); bundle
>   markers are string sentinels.
> - **Owner answers** (later the same day, `scanner-owner-answers.md`): the band title may add the holder's name
>   (`{{holder.firstName}}` or `{{holder.name}}`, no other binding) and take 2 lines for 1 more unit (4.6, DM R16);
>   two blueprints, **Balance card** and the new **Stamp card**, ship displays (11, DM R19); no item names in the
>   ledger (17); starters are now **Blueprints**, which never issue, so the scanner sees only real templates (D21);
>   the earliest next scan is T0 + 350 in every doc (BM M2 fixed).

**Base.** `next/integration` at `237b4ce` (re-checked in review; n6 and n7 merged at `df27670`, `150e0ee`), so
everything below builds on their code, not on their branches. The platform map was written
at `6687b4d`, before those merges; its n6/n7 facts still hold. The initial web budget is now `232,500 B`
(`tools/check-bundle.ts:11`); re-measure headroom before the first scanner build.

**Precedence.** This file wins over `arch-access.md`, `arch-server.md`, `arch-client.md`, `ux-door.md`,
`ux-desk.md`, `ux-admin.md` and `buddy-motion.md` wherever they differ. Those files stay the detail references for
what this file does not restate: screen layouts and copy (the UX docs), the client reducer tables and decoder
constants (`arch-client.md`), the beat choreography (`buddy-motion.md`). Section 1 lists every conflict and its
resolution, so a builder knows which detail survived. Two later inputs are detail references too:
`docs/design/scanner/display-model.md` (**DM**) wins on result content (the display model, its contract, the renderer
and the editor) and `docs/design/scanner/b-final.md` (**BF**) wins on result geometry, tokens and motion. This file
summarizes both and wins where they differ on data and behaviour.

Cited as: **AA** arch-access, **AS** arch-server, **AC** arch-client, **UD** ux-door, **UK** ux-desk, **UA** ux-admin,
**BM** buddy-motion, **PM** platform-map, **DM** display-model, **BF** b-final README, **R** research report (critic
block overrides its body), **NW** `next/docs/design/next-wave.md`. Paths are relative to the repo root. **[U]** =
verify on a device.

---

## 0. Decisions

| # | Decision |
| --- | --- |
| 1 | **A scanner is one credential for one org and one mode.** Kind `device` (a browser on `/scan`, cookie) or `terminal` (a till, bearer token). Its name is its place ("Front door"), shown as *where* on every heads-up. Many phones at one door are many scanners (**Duplicate** in the console). |
| 2 | **Two principals scan:** a scanner, or a platform admin's own session ("Scan as admin", rights of a Manager, for rehearsal and spot checks). Both become one `ScanActor` in the guard, so every service has one code path. API keys never act on passes through the scanner; they get `scans:read` (feed only). |
| 3 | **No org membership in this wave.** NW excludes org-scoped admin roles. The console stays platform-admin only. Tenant self-serve is a later platform stream; section 2.10 keeps the seam. |
| 4 | **Staff are org people who scan, with a name, a role and a 6-digit PIN.** No platform account, no console access, no mode. Roles form a ladder **Door ⊂ Desk ⊂ Manager**. A scanner runs as its **role without sign-in** (Door or Desk, never Manager) or asks staff to sign in. A Manager's PIN approves one risky action in place. This replaces AA's staff codes (they need org membership) and UK's separate manager codes. |
| 5 | **Rights = role ≥ the template action's `minRole`.** Over the action's `max`, `set`, cooldown overrides and undo past the own window need a Manager. The server decides; the client mirrors with visible locks. |
| 6 | **Events are admin objects** (`scan_events`): name, 1-20 templates, an optional match rule (input in values), a window with a time zone, optional capacity, re-entry. A scanner accepts **one event or a set of templates**. Events key "once per event", make "x of y" exact, drive the live dashboard and broadcast targets. They replace AS's door sessions, UD's manifest `scan.event` and AA's scanner filters and window. |
| 7 | **Outcomes are data.** `ok`, `heads_up`, `refused`, `ready` return 200 with one stable reason vocabulary (section 4.2). HTTP errors are only credential, validation, rate limit and server faults. |
| 8 | **Two device endpoints act:** `POST /api/v1/scan/resolve` (read, the desk card) and `POST /api/v1/scan/actions` (write; takes a raw code, so the door is one round trip). Every input (camera, wedge, NFC reader, typed code, picked search row) goes through one resolver. |
| 9 | **Action kinds are `check_in`, `add`, `take`, `set`, `use_up`.** One meaning each, 1:1 with the designer's words. Re-entry is a direction (`in`/`out`) on check-in, allowed by the event, not a template kind. |
| 10 | **Atomic gates.** `scan_gates` (one row per pass, action and scope) decides first-scan-wins, cooldowns and in/out with one UPSERT. Value actions commit their scan row in the same D1 batch as the pass CAS (a new `commit` hook on `publishPass`), so they are exactly-once. |
| 11 | **Scans never spend the push budget by default.** Check-in publishes nothing. Value actions publish with `notify: false`. A template action may opt in (`notify: true`), and n7 then counts and silences it like any publish. |
| 12 | **`/scan` is its own HTML entry** (`scan.html`), not an SPA route. Camera, CSP and the bundle budget are per document. It shares chunks with the SPA. |
| 13 | **Decoder:** `zxing-wasm@3.1.6` reader in a module Worker on every iPhone and iPad; native `BarcodeDetector` only where it covers the scanner's formats (never Safari). |
| 14 | **Offline in three steps.** v1 online only, with idempotent "Not confirmed" retries. v2 opt-in per event scanner, check-in only, a hash roster limited to passes whose barcode is the scan code. v3 a `/scan` service worker. Values are never queued. |
| 15 | **NFC ships off.** The VAS message is the pass's scan code. One reader key pair per (signing identity, org), **generated in the browser; PassBook stores only the public half**. Five build gates, the first a platform flag `nfc.enabled` (default false) that the owner turns on after Apple approves. |
| 16 | **The buddy:** one per view, with **one seat on `/scan`: the dock** (XL, 192 × 144 phone, 256 × 192 iPad). Its middle (violet) pass is the result card while a result is up. Beats live in the scan chunk; a beat starts 150 ms after the verdict, lasts 550 ms, is still by T0 + 700 ms, and the next scan cuts it in one frame (BM, BF). |
| 17 | **Proof outlives the ledger.** `scans` keeps check-in proof for `retention.scansDays` (default 396 days, 13 months). The Sync log (`pass_events`) keeps its 90 days. |
| 18 | **Connection-owned inputs are refused** (`managed_elsewhere`) unless the action opts in with `allowOnConnected`, which marks the input manual. No outbound write-back; a pull feed `GET /api/v1/scans` serves POS and CRMs. |
| 19 | **Console:** one nav item **Scanning** at `/admin/scanning`, tabs **Scanners · Events · Staff · Scans** (2026-11-05: **Devices · Events · Zones · Staff · Scans**, D27, D34). NFC setup lives on the Apple identity page. |
| 20 | **Audit gets a `scanner` actor** (a safe `audit_log` rebuild in `0014`). Individual scans go to `scans` and the ledger, never audit. |
| 21 | **What a result says about a pass is template data.** `manifest.scan.display` (`ScanDisplayDoc`, DM) holds the `ok` icon and title, the meta line, chips, 0-2 panels of typed rows, notes, header variants and the holder line's source. Baked packages, blueprints and uploads ship one; the designer's **Scan screen** mode edits it. Blueprints never issue passes: **Use blueprint** makes a real, org-owned template with a copy of the display, so a scanner only ever sees real templates. No per-pass, per-scanner or per-event documents. |
| 22 | **The system owns the verdict.** Tint, ring, verdict band (glyph, headline, sub), holder line, pass tile, flags, the action area, the last-scan strip and the buddy are system content the display can't reach. `heads_up` ignores the custom icon and title; `refused` shows no template content except `notes.refused`. Verdict copy is `SCAN_COPY` only. |
| 23 | **The server renders, the client paints.** `ScanCard.display` and `ScanOutcome.display` are a fully rendered `ScanDisplay` (strings, numbers, asset URLs, `oneLine` hints; never an expression). Role filtering removes elements and data before evaluation; email, phone, the scan code, the barcode and tokens are never in scope for any role. A render error falls back to the default display and never blocks a verdict. |
| 24 | **Scan history is computed from `scans`,** not a ledger table: visits, last visit, check-in state and the per-input value ledger, through one partial index (`scans_pass_ok`). A change made outside the scanner shows as one **Changed elsewhere** row. |
| 25 | **A display-only template version activates on save** and moves no pass: `template_versions.build_key` excludes `scan.display`, so equal keys mean no rebuild, no push, no R2 write. Scanners read the display from the template's **active** version on their next request. |
| 26 | **The result surface is the card (B strengthened, BF).** The camera stays live under a full-screen verdict tint and a 10 px ring; the buddy's violet pass rises into the result card; a different code is accepted from T0 + 350 and interrupts it. Desk `ready` is a panel over the dimmed camera, with the template's panels and a **system action area** (stepper, keypad, review in the card; the commit pair in the dock). The display contract carries no geometry or colour, so the visual direction stays a client choice. |
| 27 | **Every paired thing is a device row in `scanners`.** `kind` is the ceiling (`device` a paired browser, `terminal` a till, `display` a screen-only browser); `device_role` is what it does now (`scan`, `customer`, `monitor`). One pairing flow, cookie, revocation, audit and console list for all. The console tab **Scanners** becomes **Devices** (18.1). |
| 28 | **A station is the scanners and Customer screens at one counter or door.** A device is in at most one station, so a customer's name and balance only reach the screen beside them. **Desk monitors watch a scope** (own station, ≤ 8 stations, an event, ≤ 8 zones, or the whole org) with a Door or Desk audience, never Manager (18.2). |
| 29 | **Screens never act.** A device whose role isn't `scan` gets 403 `SCREEN_ONLY` from the guard (2.5 step 4). Customer screens get only a `ScanCustomerView`: every refusal and heads-up reads **Please see the desk**, a first name at most, no reason, staff, note or photo (18.4). |
| 30 | **Realtime is one `ScanHub` Durable Object per org and mode**, raw WebSocket Hibernation API, no framework. Scans stay HTTP; the Worker publishes after the D1 commit in `waitUntil`; the hub routes pre-rendered bodies by socket tags and keeps a short numbered buffer for replay; HTTP catch-up on the same buffer is the fallback. D1 stays the record. An org with no screens publishes nothing (18.5). |
| 31 | **A paired phone flips itself** to Customer screen (**Show to customer**) and back with a staff PIN (a 2 s hold when the org has no staff). A `display` changes role only in the console (18.3). |
| 32 | **Access is a policy on a template, not an action kind.** `scan.access` turns the template's `check_in` into a door grant: repeat `always`, verdict **Access granted**, no `already_done`. `ScanActionKind` stays the five (19.1). |
| 33 | **Plans on the template, one per pass.** 1-12 plans: **24/7** (`always`), **Timed** (weekly hours), **Guest** (a window, optional visit limit). Per pass: plan, add-on zones, start, end, visit limit, sponsor. Hours are never per pass (19.2). |
| 34 | **Zones are org data**, nested (a root site plus 3 levels), granted by key; a grant on a parent opens its children. A scanner checks 0-8 zones (OR); none means any zone. Hours are wall clock in the zone's time zone (root, else org, else scanner) (19.3). |
| 35 | **Visits, not grants, are counted**: a grant more than `visitGapMinutes` (120) after the last starts a visit. One `scan_gates` row per pass (scope `access`) counts visits, enforces the guest limit and the optional re-entry wait. No anti-passback (19.4). |
| 36 | **Five red reasons** (`zone_not_included`, `outside_hours`, `guest_expired`, `guest_visits_used`, `suspended`); `not_yet_valid` is red on access templates. A Manager may **Let in anyway** on the four soft ones plus `not_yet_valid` (19.5). |

---

## 1. Conflicts resolved

| Topic | The inputs said | Decision | Why |
| --- | --- | --- | --- |
| Principal | AA: scanner = policy with shared/personal/terminal devices; AS: scanner = one credential; UA: scanner = one paired device | One credential (device or terminal); no personal devices | One revocation unit, one row, matches the console UX. Personal devices only existed to fix the admin's 1 h idle; "Pair this phone" fixes that |
| Admin scanning | AA: only through a personal device; AS, UD, UA: own session | Own session, normalized into `ScanActor` | Rehearsal and spot checks without setup; one service path after the guard |
| People | AA: org members + staff codes (step 2); UA: staff with PINs; UD: free-text name; AS: none | UA's staff with PINs, scanner-local | NW excludes org roles; PINs need no account, no email, no console. AA's PIN objections are met in 2.7 (keyed hash, per-staff lockout, PIN only works on a paired device of that org) |
| Approval | AA: manager staff code; UK: org manager codes; UA: manager PIN | Manager PIN, per action, no stored grant | One secret per person, one sheet |
| Rights model | AS: capability list; AA: policy kinds/limits; UA: role ladder + `minRole` | Role ladder + `minRole` + action `max`; optional scanner `dailyAmount` cap | Fewer knobs; readable on both sides |
| API keys | AA: `scans:read/write/override`; AS: `scans:read` + terminal scanners | `scans:read` only; machines that act are terminal scanners | One acting principal; per-terminal templates, role and limits |
| Pairing code | UD: 8 digits; AS, UA: 8 Crockford; AA: 10 Crockford | 10 Crockford base32 (50 bits), shown `K7QH2-M9XTR` | Entropy margin behind venue NAT; the QR is the main path |
| Pairing link | UD: `?pair=`; others `#pair=` | `/scan#pair=CODE`, stripped at boot, confirm card, `pair/preview` consumes nothing | Fragments never reach logs or Referer; `/scan` is its own entry, so `isPublicPath` no longer matters |
| Token | AA: `wls_` + 43; AS: `pbs_<8>_<43>` | `wls_<8>_<43>`, prefix lookup + constant-time compare | Same scheme as API keys (`wlt_`) |
| Events | AS: door sessions; UD: manifest `scan.event`; AA: scanner filters + window; UA: admin events | UA's admin events with AA's multi-value match | Capacity, dashboards and broadcasts need a first-class object. "Session" collides with sign-in |
| Action kinds | NW, R, AS: `check_in/redeem/increment/set` (+ AS `check_out`); UA: `check_in/add/take/set/use_up` | UA's kinds; check-out is a direction | "redeem" meant two different things |
| Repeat | AS: `never/per_session/cooldown/always`; UA: `once/daily/wait/always` | `once/daily/cooldown/always`; `once` is per event under an event | Gyms need daily; per-session falls out of event scope |
| Reasons | UD and AS used different names | One list (4.2) | The client only maps codes to copy |
| Time mismatches | AS: red; UD: amber | Amber `not_yet_valid` / `ended` (pass window or event window); `wrong_event` (match rule) stays red | A genuine pass of this org; staff talk |
| Let in again | UD: on; AA: approval; AS: Manager capability; UA: Manager | Scanner setting `letInAgain: anyone/manager/never`, default `anyone`; always recorded | The decision is made at the door; every override is attributed and on the dashboard |
| Gate table | AS `scan_state`; UA `scan_claims` | `scan_gates` with AS semantics | In/out, cooldown and release need state, not just a claim |
| Lookup | AS: GET `?q=`; AC asked for POST | `POST /api/v1/scan/lookup` | A name never sits in a URL |
| Offline | UD: opt-in in v1; AC: v2 | AC's v1/v2/v3; v2 roster only for scan-code barcodes | A hash of `TICKET-0001` is enumerable; a hash of a 128-bit code is not |
| Client entry | UD, UK, UA: lazy route | Separate `scan.html` (AC D1) | Permissions-Policy and CSP are per document |
| Offline indicator | UD: shell banner; AC, UK: chip | Chip | The banner shifts the viewfinder |
| Beat timing | AC: ≤700; UD: ≤600; BM: 550 | BM: delay 150, length 550 | Still by T0 + 700 |
| Sound | AC `sound/`; BM `buddy/sound.ts` | `src/web/scan/sound/` with BM's chirps | Sound is not the buddy |
| NFC keys | R: per identity, stored; AS: per (identity, org), stored encrypted, exported; UA: per identity, browser-made, public only | Per (identity, org), browser-made, public only | Org A's reader can't read org B on the shared pass type ID; no private key at rest, no KEK gap |
| NFC identity | AS: NFC on existing `pass.im.plrs.wallet`; UA: always a new DB identity | Ask Apple for the existing ID; a new ID works too | `db-resolver.ts:69` already applies the row flag to the platform identity; existing passes gain NFC by reissue |
| Audit actor | AA, AS: rebuild with `scanner`; UA: reuse `device` | Rebuild | `device` means Apple devices; no table references `audit_log`, and no later migration touches it (checked) |
| Ledger kinds | AS: `scan.rejected` + `data.outcome`; UA: new `scan.heads_up` | Add `scan.heads_up`, `scan.checked_out`, `scan.undone`; group `scans` | Tone and filters by kind, not by data |
| Blueprints | AS: keep store card and generic barcodes; UA: all to scan code | Event ticket, coupon, generic → `{{pass.scanCode}}`; store card keeps `{{cardNumber}}` + `scan.lookup` | Tills read card numbers; the rest want unguessable codes |
| Heartbeat | UA: `POST /scan/heartbeat` | The idle `GET /scan/stats` poll touches `last_seen_at` | One call |
| Milestones | AS: `hundred/all_in`; BM: `count/all_in/reward` | `count`, `all_in`, `reward`, all decided server-side | One source with the counter |
| Scans retention | AS: 400; UA: 396 | 396 days | 13 months spans a yearly event |
| Nav | AA: Scanners + Activity; UA: Scanning + 4 tabs | Scanning, 4 tabs, `/admin/scanning` | Covers events and staff |
| Pause | AA: pause/resume | Not built | Event windows and revoke cover it |
| `set` races | AS: last writer wins; UK: `expectedVersion` | `expectedVersion`; mismatch is heads-up `stale` | Uses `publishPass` 412 |
| Result content | AS, UK: fixed `scan.values` (≤ 3) and `scan.identity` (photo, ≤ 2 fields); the owner: customize text, icon and info cards per template, from any pass data | `scan.display` (D21, 4.6); `values` and `identity` removed; the card's `values` stay as system data derived from action inputs | Per-template design the owner asked for, with the verdict kept system-owned |
| Per-event display | DM drafts: per-event overrides | Dropped. Events keep check-in logic and an optional staff note (`scan_events.note`), shown on the Start panel, `heads_up` and `refused` | Two places to edit one screen is how screens drift; one night's instruction doesn't need a template version |
| Result layout | UD/UK: a verdict flood over the stage, a small card at its foot; A: verdict band on top, sheet below | B strengthened (BF): live camera, tint and ring, the card risen from the buddy's pass, A's 40 px headline and solid glyphs | The owner's pick of B, with A's arm's-length verdict strength |
| Next code after a verdict | AC, UD, BM M2: 600 ms, decoding paused during the verdict | Decoding resumes at T0; a different code is accepted from T0 + 350 | The card is upright by then; at most one verdict change per 350 ms |
| Buddy seats | BM §3: viewfinder, result card, sheets, desk card | One seat on the dock, XL; `card: 'in' \| 'out'` hides the violet pass while it is the card | The card comes to the buddy; no seat changes, no remounts |
| Ticket columns | DM v1: 2-3; B: 4 | 2-4 items, one line when values fit the compact cap, else two per line (`oneLine`) | Section · Row · Seat · Gate is the commonest ticket |
| Controls in a card | B: Redeem inside the Loyalty card | Never. A reached goal promotes its `take` action to the dock's primary button | The display can't hold anything that acts |
| Fit budget | DM drafts: 7 units per result; BF: max 443 px, VIP at 6 units is 434 | 6 units with frames, minus a per-screen header cost; save error on `ok`, render-time cut elsewhere; overflow scrolls the body | Measured, not estimated; the verdict never moves |
| Store card and stamps | SA draft: stamps on the store card; AS and its data: a USD `balance` | Two blueprints: **Balance card** (Charge, Top up, Set balance on `balance`; Balance display) and a new **Stamp card** (Add stamp, Redeem reward on `stamps`; Loyalty display) | Stamps on the store card would change its passes; a new blueprint changes none (owner, 2026-11-04) |
| Band title | DM R16, first pass: literal only | Literal text plus the holder's name only; 2 lines cost 1 unit | Owner, 2026-11-04: "I like allowing names." |
| Device role name (11-05) | ST, RT: `scanners.role`, `ScannerAuth.role` | `scanners.device_role`, `deviceRole` everywhere | `role` already means the staff ladder (`scan_staff.role`, `ScanActor.role`); one word, one meaning |
| Where screens are refused (11-05) | ST A3: right after the credential | After the rate limits (2.5 step 4) | A looping screen is throttled like any device; a suspended org answers `ORG_INACTIVE` first on every face |
| Hub config (11-05) | ST §4.10: `migrations: [{ tag, new_sqlite_classes }]` | RT: the declarative `exports` field | Checked against the live docs and wrangler 4.151.1; a Worker uses one or the other, and ours has no DO yet |
| Desk monitor credential (11-05) | RT: admin sessions may open desk sockets; terminals get 60 s tickets | Only paired device cookies; no tickets | One principal, one revocation path (RT §10.2's own recommendation); terminals publish, never listen |
| Audiences (11-05) | RT: `customer, door, desk, manager` | `customer`, `door`, `desk`, plus `scan` (presence only) | Monitors cap at Desk; approvals stay on scanners |
| Close codes (11-05) | RT: station change and staff sign-out kick 4403 | 4403 revoke, unpair, expiry, org suspended; 4409 reconfigure; staff sign-out kicks nothing | 4403 sends a device to the block panel, wrong for a rename |
| Replay (11-05) | RT: one 15-minute buffer for all audiences | Customer rows kept 30 s, replayed only if < 10 s old; staff rows 15 min / 500 | A reconnecting customer screen must never show the previous customer |
| Customer chips (11-05) | ST: ≤ 2 ids in `customer.chips` | ≤ 2 from any one header (base or variant); schema `max(18)` | Display ids are unique in the doc, so a plan chip per variant has its own id; one header renders |
| Customer refusal subs (11-05) | ST: every refusal **Please see the desk**, no sub | Plus a sub on three: `outside_hours` **Your plan opens {when}.** (none when nothing opens within 7 days); `guest_expired`, `guest_visits_used` **Your guest pass has ended.** Never the zone or a suspension | The member can act on it alone (AX C2) |
| Blueprint chip ids (11-05) | Package draft: three chips with id `plan` | `c_plan`, `c_timed`, `c_guest`; the customer block names all three | DM ids are unique; the package was fixed and passes `check-package.mjs` |
| Access milestones (11-05) | AX: M2-M4 tasks; ST: after M1 to M4 | Two milestones of their own: **M2A Access** and **M3A Stations**, both in the release (plan §1.2) | Access needs M2's Manager approvals; stations need M2's desk `ready` and review |
| e2e names (11-05) | ST, AX: `e2e/17-*` | `e2e/16-scan-stations.spec.ts`, `16-scan-access.spec.ts` | 16 is the scanner wave's prefix |
| Lookup on a customer screen (review 11-05) | ST: every resolve and act publishes a customer body | Only when the request's `input` is a `code`; a lookup reaches monitors only; the scanner sends `idle` when the desk card closes | Staff looking up someone else must not put that person on the counter screen |
| Lost kicks (review 11-05) | ST, RT: kicks in `waitUntil`, "a missed kick is harmless", 12 h attachments | Revoke, unpair, role and watch kicks awaited with a retry; 15-minute attachments checked before every send | A lost kick left a revoked or re-roled screen receiving for up to 12 h |
| Zone routing (review 11-05) | ST, AX: `w:zn:` on the scan's deciding zone | The device's checked zones plus ancestors | Refusals decided before the zone step have no zone, and a site watch missed its child zones |
| Access times (review 11-05) | AX: the client formats access times in the device's zone | `ScanAccess.timeZone` (P0-5); customer times formatted on the server | A door's site can be in another time zone than the scanner's setting |
| Guest end (review 11-05) | AX: computed at build and again at scan; the reference ignored `days` | Written into `until` at issue; `days` honoured | An org time zone change moved the door's end away from the face's **Until** |
| Access undo and gate (review 11-05) | AX: "restore `prev_*`"; gate keyed by the action id; "one ok, one refused" for a 1-visit race | One-step undo while the gate points at the grant; `action_id = 'access'`; a race inside one visit lets both in | The old rules could double-restore, split counts on a rename, and the race claim contradicted the gap rule |
| Any-zone scanners (review 11-05) | Reference: named the first org zone; an unknown zone id fell to `*` | `zone: null` and no sub; unknown ids grant nothing | The front desk said **Pool**; a stale id opened every door |
| Customer beat (review 11-05) | BM: beat derived from the band's words | `ScanCustomerView.cue { kind, unit }` | Copy changes must not change motion |

---

## 2. Access model

### 2.1 Principals

| Kind | Credential | Reach | Mode | CSRF | Limits |
| --- | --- | --- | --- | --- | --- |
| `session` (admin) | `__Host-wallet_sid` | Console: every org. `/scan`: one org it picks per request | `x-passbook-mode` (n6) | `x-csrf-token` | as today; `RL_SCAN` on scan routes |
| `session` (user) | same | own passes | — | same | refused on every scan route (403) |
| `api_key` | `Bearer wlt_…` | its org or all | key row | none | `RL_API_KEY`; scan feed only (`scans:read`) |
| **`scanner`** (new) | cookie `__Host-wallet_scan` (device) or `Bearer wls_…` (terminal) | one org; `/api/v1/scan/*` only | scanner row | cookie: `x-csrf-token` = scanner secret; bearer: none | `RL_SCAN`, `RL_SCAN_LOOKUP`, `RL_SCAN_ORG` |
| Apple device | `ApplePass` | one pass | — | — | unchanged |

A scanner never satisfies `requireSession`, `requireAdmin` or `requireApiKeyOrAdmin`. A `wls_` bearer fails
`apiKeys.resolve` with 401. If a browser holds both a scanner cookie and an admin session, the scanner wins on
`/api/v1/scan/*`; `/scan` shows which one scans and offers **Stop using this scanner**.

### 2.2 Scanners, staff and roles

**Scanner settings** (`scanners.settings`, JSON validated by `ScannerSettingsSchema`):

| Setting | Values | Default | Meaning |
| --- | --- | --- | --- |
| `flow` | `auto`, `choose` | `auto` for an event; `choose` when an accepted template has a `take`, `set`, an asked amount or several actions | Door applies the first action on scan; desk opens the card |
| `defaultActionId` | action id or null | null = the template's first action | used by `auto` |
| `roleWithoutSignIn` | `door`, `desk` | `door` | the role when nobody is signed in |
| `staffSignIn` | bool | false | ask staff to pick their name and enter their PIN |
| `letInAgain` | `anyone`, `manager`, `never` | `anyone` | who may override `already_done` on check-in, `not_yet_valid`, `ended`, `capacity_full` |
| `reader` | `none`, `barcode`, `nfc` | `none` | client hint: chip, stage, `method: 'nfc'` mapping |
| `lookup` | bool | true | name or email search (typed codes always work) |
| `offline` | bool | false | v2; event scanners only |
| `dailyAmount` | int or null | null | sum of \|amount\| per scanner per day; above it `limit_reached` |

The scanner row also holds `mode`, `kind`, `name`, `time_zone` (IANA, from the creating admin's browser), and what it
accepts: `event_id`, or rows in `scanner_templates` (1-20). Exactly one of the two.

**Effective role** of a scan:

| Actor | Role |
| --- | --- |
| Admin session | `manager` |
| Scanner with a signed-in staff member | that staff member's role |
| Scanner, nobody signed in (`staffSignIn` off) | `roleWithoutSignIn` |
| Scanner with `staffSignIn` on and nobody signed in | none: 403 `STAFF_REQUIRED` |

A device alone never has Manager rights. Manager rights need a Manager's PIN (signed in, or approving one action) or
an admin session.

**Template action defaults** (`minRole`): `check_in` door; `add`, `take`, `use_up` desk; `set` manager.

### 2.3 Matrix A: console and API (this wave)

| Action | Platform admin | API key `scans:read` | Staff | Holder |
| --- | --- | --- | --- | --- |
| Scanners: create, edit, pair, pair here, revoke, mode, duplicate, terminal token, sample pass | yes | no | no | no |
| Events: create, edit, assign scanners, archive, live dashboard | yes | no | no | no |
| Staff: add, edit, reset PIN, disable | yes | no | no | no |
| Scans log, scan detail, per-scanner stats | yes | feed `GET /api/v1/scans` (no names, no titles) | no | no |
| Export CSV | yes (audited) | no | no | no |
| Undo any scan of the org (≤ 30 d) | yes | no | no | no |
| Template scan actions, Scan screen (display) and NFC section (designer); event staff note | yes | no | no | no |
| NFC: platform flag, identity approval, reader keys, reader test | yes | no | no | no |
| Own pass's last scan (portal, later slice) | — | — | — | yes |

### 2.4 Matrix B: on a scanner

Every cell also requires: the pass is in the scanner's org and mode, its template is accepted, the event match rule
holds, and the template defines the action.

| Action | Door | Desk | Manager (signed in, or PIN approval) | Admin session | Terminal |
| --- | --- | --- | --- | --- | --- |
| Look up by code (camera, reader, NFC, typed) | yes | yes | yes | yes | yes |
| Search by name or exact email (`lookup` on) | yes | yes | yes | yes | no |
| Action with `minRole` ≤ role | yes | yes | yes | yes | its role |
| Action above role | needs approval | needs approval | yes | yes | no |
| Amount above the action's `max` (≤ input schema maximum) | needs approval | needs approval | yes | yes | no |
| Check out (event re-entry on) | yes | yes | yes | yes | no |
| Let in again: `letInAgain = anyone` | yes | yes | yes | yes | no |
| Let in again: `letInAgain = manager` | needs approval | needs approval | yes | yes | no |
| Override a cooldown on `add`/`take` | needs approval | needs approval | yes | yes | no |
| Undo own scan ≤ `scan.undoWindowMinutes` (10) | yes | yes | yes | yes | yes |
| Undo another scan on this scanner, same local day | needs approval | needs approval | yes | yes (any of the org, 24 h) | no |
| Bundle check-in (event scanners) | yes | yes | yes | yes | no |
| See card: holder line, template, status, values, flags, last 3 scans, and the template's display filtered by role (photo only when `display.photo` admits the role; elements and inputs above the role removed, 4.6) | yes | yes | yes | yes | summary only (identity, header, notes; no panels) |
| See masked email | search rows only | same | same | same | no |
| See full email or phone | never | never | never | never (console has it) | never |
| Export | never | never | never | never | never |

"Own scan" means same `actor_key` and, when staff are signed in, same staff member.

### 2.5 Guards and scopes

Foundation files (`platform/*`) get the principal; `modules/scan` gets the actor.

```ts
// src/worker/platform/auth.ts (foundation, via integration)
export const SCANNER_COOKIE = '__Host-wallet_scan';
export const SCANNER_TOKEN = /^wls_[A-Za-z0-9]{8}_[A-Za-z0-9_-]{43}$/;
export interface ScannerAuth {
  kind: 'scanner';
  scannerId: string;
  orgId: string;
  mode: Mode;
  transport: 'cookie' | 'bearer';
  csrfSecret: string | null;      // cookie only
}
export type AuthContext = SessionAuth | ApiKeyAuth | ScannerAuth;
export interface ScannerStore {
  /**
   * Null for an unknown or malformed token. A token that still matches a revoked or expired row
   * throws 401 SCANNER_REVOKED or SCANNER_EXPIRED, so revoke and expiry keep the token columns
   * (2.7). Touches last_seen_at at most every 60 s, and only when the row is older than that.
   */
  resolve(token: string, transport: 'cookie' | 'bearer'): Promise<ScannerAuth | null>;
}
// AuthStores gains `scanners: ScannerStore`; denyAllStores resolves null.
```

| Helper | Change |
| --- | --- |
| `csrfGuard` (`platform/csrf.ts`) | `scanner` + cookie: same origin and `x-csrf-token` = `csrfSecret`. Bearer exempt |
| `assertOrgAccess` | a scanner may touch only `auth.orgId` |
| `modeOf` | unchanged: `auth.mode` |
| `Actor`, `actorOf` (`platform/context.ts`) | `{ type: 'scanner'; id: scannerId }` |
| `reportDenied`, `DeniedEvent` (`platform/denied.ts`) | accepts scanners; actor type `scanner` |
| `Actor` (`modules/passes/service.ts`), `actorFor`, `orgScopeOf` (`passes/http.ts`) | `scanner` passes through (not folded into `system`); `orgScopeOf` returns its org |
| `ApiScopeSchema` (`contracts/common.ts`) | adds `scans:read` (beside n7's `messages:write`) |
| `requireAdmin`, `requireApiKeyOrAdmin`, `requireSession` | unchanged |

```ts
// src/worker/modules/scan/guard.ts (n8)
export function requireScanActor(): MiddlewareHandler<AppBindings>;   // scanner first, else admin session
export interface ScanActor {
  principal: 'scanner' | 'admin';
  orgId: string;               // scanner row, or the admin's `scope.orgId`
  mode: Mode;                  // scanner row, or modeOf(session)
  actorKey: string;            // 's:<scannerId>' | 'u:<userId>': idempotency namespace and "own"
  actor: { type: 'scanner' | 'user'; id: string };
  scanner: ScannerRow | null;  // null for admins
  event: ScanEventRow | null;  // the scanner's, or the admin's `scope.eventId`
  templateIds: string[];       // event templates, scanner templates, or the admin's choice (≤ 20)
  timeZone: string;            // event, else scanner, else the admin's `scope.timeZone`
  role: ScanRole | null;       // 2.2; null only when staff sign-in is required and missing
  staff: { id: string; name: string; role: ScanRole } | null;
  settings: ScannerSettings;   // admins: all on, letInAgain 'anyone', offline off
  name: string;                // "Front door", or "Admin console"
}
```

`requireScanActor` order, every scan route:
1. Credential: `Bearer wls_` (terminal), else the scanner cookie, else an admin session (role `admin`, CSRF). A
   user session gets 403 `FORBIDDEN`; nothing gets 401 `SCANNER_UNAUTHENTICATED`. A scanner request that carries
   `scope` gets 422 `SCAN_SCOPE_NOT_ALLOWED` (a scanner's reach comes from its row only). An admin `scope` must name
   an existing org; its `eventId` and `templateIds` must belong to that org (and the event to the header's mode),
   else 404 with the body of an unknown id. An admin sends it as `scope` in a JSON body, or on a GET as
   `?orgId&eventId&templateIds&timeZone` (`GET /session`, `/stats`, `/summary` and the asset `<img>`); an admin with
   none gets 422 `SCAN_SCOPE_REQUIRED`, and a body that is not JSON gets 422 `SCAN_BODY_INVALID`.
2. `isOrgActive` (`modules/orgs/active.ts`); suspended: 403 `ORG_INACTIVE`.
3. `RL_SCAN_ORG` (`org:<id>`), then `RL_SCAN` (`actorKey`).
4. **Device role** (2026-11-05): a scanner principal with `deviceRole ≠ 'scan'` (a Customer screen or Desk monitor)
   gets 403 `SCREEN_ONLY`, except on routes declared with `screens: true` (`GET /scan/session`, `POST /scan/unpair`).
   Admin sessions have no device role. The live routes use their own guard (18.6).
5. Staff binding: expire it past 15 min idle or 12 h; `staffSignIn` on and none bound: 403 `STAFF_REQUIRED`
   (except `GET /scan/session`, `POST /scan/staff`, `POST /scan/unpair`).

`ScannerAuth` gains `scannerKind: 'device' | 'terminal' | 'display'` and `deviceRole: 'scan' | 'customer' |
'monitor'`, read by `ScannerStore.resolve` in its existing statement (`addendum/p0-amendments.md` P0-2).

`scanPolicy(ctx, actor, action, request)` in `modules/scan/rules.ts` is the only place rights are decided (2.4,
2.6). Routes never check roles.

### 2.6 Evaluation order on every scan call

Steps 1-4 are the guard (HTTP errors). Steps 5-16 answer 200 with an outcome, in this fixed order, so the same pass
always gets the same answer. **Access templates** (a template with `scan.access`, on a scanner without an event) run
steps 10a-10e after step 10, skip 11-12, and pass the access gate at 15 (section 19.4); everything else is unchanged.

1. Credential resolves, not revoked or expired.
2. Org active.
3. Rate limits, then the device role (screens: 403 `SCREEN_ONLY`).
4. Staff binding when required.
5. Candidates **within the actor's org**, `deleted_at IS NULL` (section 8.3). None: `not_found`.
6. Mode: keep the actor's mode. None left: one in the other mode gives `test_pass` or `live_pass` with **no card**
   (only `template.name`): a test scanner never sees a live holder's title, and the reverse.
7. Template accepted: else `not_accepted`.
8. Event match rule: else `wrong_event`.
9. More than one left: `ambiguous`.
10. `removed` (`removed_at`), then `voided` (or heads-up `already_done` if a `use_up` scan voided it), then `expired`
    (`validityOf(passJson, now)`).
11. Pass window (`scan.window`): `not_yet_valid` or `ended` (heads-up, `at`).
12. Event window: `not_yet_valid` or `ended` (heads-up, `at`).
13. Stop flags under `auto` without `confirmed`: heads-up `check_required`.
14. Action: role and `max` (else heads-up `needs_approval`, no row written, no idempotency entry); connection
    ownership (`managed_elsewhere`); daily cap (`limit_reached`); capacity (`capacity_full`).
15. Gate (section 7.3): `already_done`, `cooldown`, `in_progress`.
16. Effect: `no_balance`, `stale`, or `ok`.

Overrides (`overrideOf`) skip step 11, 12, 14's capacity and 15's gate for the reasons the actor may override (2.4),
and record `override_of`. `overrideOf` must name a `scans` row of the same org, mode, pass and action, with outcome
`heads_up`, an overridable reason (`already_done`, `cooldown`, `not_yet_valid`, `ended`, `capacity_full`), written by
the same `actor_key` in the last 10 minutes and not already overridden; anything else is 422
`SCAN_OVERRIDE_INVALID`. Without this a Door device could skip every gate by quoting any scan id.

**Access overrides** (19.5) widen this: on an access template, `overrideOf` may also name a `refused` row with
`zone_not_included`, `outside_hours`, `not_yet_valid`, `guest_expired` or `guest_visits_used`, and the override needs
a Manager (signed in, or a PIN approval) whatever `letInAgain` says, unless `letInAgain` is `never`. It skips 10b-10e
and the gate's limit and wait, and still records a visit.

### 2.7 Credentials

**Pairing a device.**
1. Console: **New scanner** or **Pair again** calls `POST /api/v1/scanners/{id}/pairing` → `{ code, url, expiresAt }`.
   10 Crockford base32 characters, 10 minutes, stored as SHA-256 in `scanners.pair_code_hash`. A new code replaces any
   live code of that scanner.
2. QR of `{origin}/scan#pair=K7QH2M9XTR` on the buddy's QR sign (`portal/add/scan.tsx`), plus the typed form.
3. `/scan` reads `#pair=` once at boot, `history.replaceState` to `/scan` before any request or camera, then calls
   `POST /api/v1/scan/pair/preview { code }` → `{ scannerName, orgName, mode }` (consumes nothing) and shows the confirm
   card. **Pair** posts `POST /api/v1/scan/pair { code }`.
4. Pair (public, `sameOriginOnly`, `RL_SCAN_PAIR` per IP): normalise (upper-case, drop separators, Crockford
   I/L→1, O→0), hash, consume with
   `UPDATE scanners SET pair_code_hash = NULL, token_prefix = ?, token_hash = ?, csrf_secret = ?, paired_at = ?, paired_label = ?, expires_at = ?, last_seen_at = ? WHERE pair_code_hash = ? AND pair_expires_at > ? AND revoked_at IS NULL RETURNING id`
   and `auditStmt('scanner.pair')` in one `db.batch`. The new token replaces the old device's at that moment. Sets
   the cookie; returns the session.
5. One answer, `PAIRING_INVALID` (400), for unknown, expired and used codes, for preview and pair alike.
6. The console polls `GET /api/v1/scanners/{id}/pairing` every 2 s → `{ state: 'waiting' | 'paired' | 'expired', device? }`
   and shows **Paired · iPhone · Safari · just now** with **Revoke** beside it.

**Pair here:** `POST /api/v1/scanners/{id}/pair-here` (admin, CSRF) sets the scanner cookie on the admin's own
browser. For the desk iPad an admin sets up in person and for an admin's own phone on a shift.

**Terminal:** `POST /api/v1/scanners/{id}/token` returns `wls_…` once (`ui/secret-reveal.tsx`); calling it again
replaces the token. Bearer only, no cookie, no CSRF.

**Token lifecycle.**

| Stage | Rule |
| --- | --- |
| Issue | `wls_<8>_<43>`: 8-char prefix plus 32 random bytes base64url. `token_prefix` UNIQUE, `token_hash` SHA-256, compared with `safeEqual`. Cookie `__Host-wallet_scan; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=15552000`. `csrf_secret` = `ctx.ids.token(32)`, returned by `GET /scan/session`, kept in memory |
| Resolve | by prefix, then hash. No isolate cache: revocation bites on the next request |
| Touch | `last_seen_at`, `last_ip_prefix` at most every 60 s. "Online" in the console = seen within 2 min |
| Expire | devices: 30 d idle, 180 d absolute. Terminals: `expires_at` set at creation (default 365 d), no idle |
| Revoke | `POST /api/v1/scanners/{id}/revoke`: sets `revoked_at` and ends any staff binding; it **keeps** `token_prefix` and `token_hash`, so the old token still matches and the next request is 401 `SCANNER_REVOKED` (clearing them would answer `SCANNER_UNAUTHENTICATED` and show the pairing card, not the **Scanner removed** panel). **Pair again** reactivates the same scanner with a new token |
| Rotate | none for devices (HttpOnly, `__Host-`, Strict; a lost rotation response would lock a door out). Terminals: Replace token |
| Unpair | `POST /api/v1/scan/unpair` always 200, clears the cookie, clears the token if valid (audit `scanner.unpair`) |

**Staff PIN.**
- 6 digits, generated server-side, shown once (`SecretReveal`), never shown again. **Reset PIN** replaces it.
- Stored as `HMAC-SHA256(K_pin, staffId ‖ ':' ‖ pin)`, where `K_pin` is derived from the platform KEK with a new
  `platform/crypto.ts` helper `derivedHmacKey(env, 'scan-pin')`. A database leak alone can't be brute-forced offline.
- A PIN works only on a paired scanner (or admin session) of the staff member's org.
- Sign-in: `POST /api/v1/scan/staff { staffId, pin }` binds `scanners.staff_id`, `staff_since`, `staff_seen_at`.
  Ends at 15 min idle, 12 h, **Switch staff** (`DELETE /api/v1/scan/staff`), revoke, or the staff member's disable.
- Approval: the action request carries `approval: { staffId, pin }` of an active Manager of the org. Verified in the
  request; nothing is stored but `scans.approved_by`.
- Misses: counter `scan:pin:<scannerId>:<staffId>`, 5 per 5 min, then that person is locked on that scanner for the
  window (400 `PIN_INVALID` with `triesLeft`, then 429), audited `scan_staff.pin_locked` once per window. Space 10⁶,
  so a stolen device needs about two years of lockouts per name. A second counter, `scan:pinall:<scannerId>`, caps
  misses across every name at 20 per hour; past it the scanner takes no PIN (sign-in or approval) until the hour
  ends, audited `scanner.pin_flood` once. Without it, an org with 20 managers would give a thief 20× the tries.

### 2.8 Principal errors (HTTP)

| Code | HTTP | `/scan` shows |
| --- | --- | --- |
| `SCANNER_UNAUTHENTICATED` | 401 | pairing card |
| `SCANNER_REVOKED` | 401 | block panel **Scanner removed** · **Ask an admin for a new code.** |
| `SCANNER_EXPIRED` | 401 | block panel **Pairing expired** · **Ask an admin for a new code.** |
| `ORG_INACTIVE` | 403 | block panel **Organization suspended** |
| `STAFF_REQUIRED` | 403 | **Who's scanning?** sheet |
| `FORBIDDEN` | 403 | (a user session) sign-in prompt |
| `PAIRING_INVALID` | 400 | **Code not valid** · **Ask for a new one.** |
| `PIN_INVALID` | 400 | **Wrong PIN. {n} tries left.** |
| `SCAN_ACTION_UNKNOWN`, `SCAN_AMOUNT_INVALID`, `SCAN_VALUE_INVALID`, `SCAN_OVERRIDE_INVALID`, `SCAN_SCOPE_NOT_ALLOWED`, `SCAN_SCOPE_REQUIRED`, `SCAN_BODY_INVALID` | 422 | refused band (client bug or a template change mid-shift) |
| `IDEMPOTENCY_KEY_REUSED` | 422 | system `server` |
| `SCAN_IN_PROGRESS` | 409 + `Retry-After: 1` | retried by the client with the same key |
| `RATE_LIMITED`, `SCAN_TOO_MANY_MISSES` | 429 + `Retry-After` | system `rate_limited` |
| `ORG_FORBIDDEN`, `MISSING_SCOPE` | 403 | API only |

`GET /api/v1/scan/session` reports `state: 'ready' | 'staff_required' | 'not_open' | 'closed' | 'unassigned'`
(`not_open`/`closed` from the event window), so `/scan` draws the right panel before any scan. A closed event still
lets staff scan: the answer is heads-up `ended`. `unassigned` means the scanner accepts nothing: its event was
archived (archiving detaches every scanner, `event_id = NULL`) or its last template was deleted. Resolve and act then
answer refused `not_accepted`; `/scan` shows the **Not set up** panel.

**Mid-shift changes.** Every `ScanCounts` carries `configRev` (the later of `scanners.updated_at` and the event's
`updated_at`; 0 for admins). Mode changes, settings saves, event moves and template edits on `scanner_templates` bump
it. When it differs from the session's, the client refetches `GET /scan/session` between scans and applies it
(posture, chips, Test band). Unsure entries, ignore windows and the v2 roster are wiped when `mode` or the event
changes.

### 2.9 Rate limits and anti-enumeration

| Binding | Id | Limit | Key |
| --- | --- | --- | --- |
| `RL_SCAN_PAIR` | 1010 | 30 / 60 s | IP (pair and preview) |
| `RL_SCAN` | 1011 | 240 / 60 s | `actorKey` (every scan route) |
| `RL_SCAN_LOOKUP` | 1012 | 20 / 60 s | `actorKey` (typed codes and search) |
| `RL_SCAN_ORG` | 1013 | 3000 / 60 s | org (protects D1's single writer) |

D1 counters (`platform/counters.ts`):

| Key | Window | Cap | Then |
| --- | --- | --- | --- |
| `scan:lk:<actorKey>` | 1 h | `scan.lookupsPerHour` (200); a typed miss counts 2 | 429 |
| `scan:miss:<actorKey>` | 10 min | 30 `not_found` from any method | 429 `SCAN_TOO_MANY_MISSES`; audit `scan.misses_capped` once |
| `scan:pairfail:<ipPrefix>` | 1 h | 30 | 429; > 500 platform-wide logs error `SCAN_PAIR_FLOOD` |
| `scan:pin:<scannerId>:<staffId>` | 5 min | 5 | 429 for that person on that scanner |
| `scan:pinall:<scannerId>` | 1 h | 20 misses, any name | 429 for every PIN on that scanner; audit `scanner.pin_flood` once |
| `scan:amt:<scannerId>` | scanner-local day | `dailyAmount` | `limit_reached` |
| `scan:export:<userId>` | 1 h | 10 | 429 |

Stations and access add **no binding and no counter** (2026-11-05): the live upgrade and the catch-up poll run under
`RL_SCAN` (the 2 s poll is 30/min of 240); beats are capped in the hub at 10/s per socket (close 1008); the flip-back
PIN reuses `scan:pin:*` and `scan:pinall:*`; display pairing reuses `RL_SCAN_PAIR`; zone and station writes are
console routes under `requireAdmin`.

Rules:
1. **The org comes first in SQL.** `WHERE scan_code = ? AND org_id = ?`, `WHERE org_id = ? AND barcode_hash = ?`.
   Another tenant's code takes the same path to the same `not_found` body. This is also what makes a shared pass type
   ID safe for NFC.
2. Exact codes only, at least 4 characters. No prefix or fuzzy matching on codes.
3. Search: a name needs 3+ characters (NOCASE prefix on title or subtitle, in org, mode and accepted templates); an
   email must be the exact normalised address; at most 10 rows, `more` flag, no paging.
4. Masking on the server: `a•••@g•••.com` (`maskEmail` in `src/shared/email.ts`, beside `normalizeEmail`: one email
   module). No phone, no download token, no capability URL in any scan DTO. Assets through the scanner asset route
   only.
5. No match and not allowed both return `{ items: [], more: false }`. For scans, "identical" means the same shape,
   reason and copy; `scanId` and `at` differ per request, so the isolation snapshot masks them.
6. Never log or audit a query, a code, a token, a pairing code or a PIN. Audit records the method, the result count and
   pass ids.

### 2.10 Seam for org membership (later)

When tenants get console access: `org_members` (org, user, role) and `requireConsole` + `assertOrgPermission`, as AA
§1.4 and §2.7 sketch. The scanner pages switch guards route by route. `scan_staff.user_id` (nullable, added then) lets a
member's staff row follow their account. Nothing in this design blocks it.

### 2.11 Audit

`auditStmt` in the same `db.batch` as the change; `detail` holds ids, enums and numbers only.

| Action | Actor | Target |
| --- | --- | --- |
| `scanner.create`, `scanner.update`, `scanner.mode_change`, `scanner.revoke`, `scanner.pairing_create`, `scanner.token_replace`, `scanner.sample_pass` | user | scanner |
| `scanner.pair`, `scanner.unpair` | scanner | scanner |
| `scanner.pair_failed` (capped 100/h) | system | — |
| `scanner.pin_flood` | scanner | scanner |
| `scan_event.create`, `scan_event.update`, `scan_event.archive`, `scan_event.assign` | user | scan_event |
| `scan_staff.create`, `scan_staff.update`, `scan_staff.pin_reset`, `scan_staff.disable`, `scan_staff.enable` | user | scan_staff |
| `scan_staff.sign_in`, `scan_staff.sign_out`, `scan_staff.pin_locked` | scanner | scan_staff |
| `scan.approve` | scanner (`detail.approvedBy`) | scan |
| `scan.override` | scanner or user | pass |
| `scan.undo` (not own) | scanner or user | scan |
| `scan.lookup` (search only) | scanner or user | — |
| `scan.misses_capped`, `scan.limit_reached` | scanner or user | scanner |
| `scan.export` | user | org |
| `nfc.key_create`, `nfc.key_retire`, `identity.nfc_change` | user | signing_identity |
| `auth.denied` (existing) | scanner joins | — |
| `scan_station.create`, `.update`, `.archive`, `.assign` (18) | user | scan_station |
| `scanner.role_change` (18; `detail`: `from`, `to`, `stationId`, `via: 'console' \| 'device'`, `unlockedBy`) | user or scanner | scanner |
| `scanner.watch_change` (18) | user | scanner |
| `scan_zone.create`, `.update`, `.archive`, `.restore` (19) | user | scan_zone |
| `pass.access_visits_reset` (19) | user | pass |

No new actor type: Customer screens and Desk monitors are `scanners` rows and audit as `scanner`.

---

## 3. Module and file layout

### 3.1 Worker

```
src/worker/modules/scan/                       n8
  routes.ts            /api/v1/scan/* (device API)
  routes-scanners.ts   /api/v1/scanners/*
  routes-events.ts     /api/v1/scan-events/*
  routes-staff.ts      /api/v1/scan-staff/*
  routes-scans.ts      /api/v1/scans (log, feed, export, undo)
  guard.ts             requireScanActor, ScanActor
  auth-store.ts        createScannerStore(env)
  pairing.ts           pairing, preview, pair here, terminal token, unpair
  scanners.ts          scanner service (CRUD, mode, revoke, sample pass)
  events.ts            event service, expected counts
  staff.ts             staff service, PIN, sign-in, approval check
  rules.ts             pure: defaults (scanOf), precedence, rights (scanPolicy), windows, flags
  resolve.ts           normalize input, candidates, narrowing, ScanCard
  act.ts               claim, gate, effect, finalize
  effects.ts           pure mutations per kind; before and after
  undo.ts              undo per kind
  group.ts             bundle check-in
  lookup.ts            search, masking, caps, audit
  outcome.ts           ScanOutcome and ScanCard assembly
  display.ts           display scope per role, `needs`, compiled-doc cache, calls renderScanDisplay; fail safe (4.6)
  repo-history.ts      history statements for the display (visits, last visit, value ledger, month sums)
  routes-display.ts    GET /api/v1/scan-display/preview (admin; the designer's real-pass sample scope, M3)
  counts.ts            today, event x of y, milestones, summaries, live
  feed.ts              scans log and feed, CSV
  assets.ts            scanner-scoped pass assets
  roster.ts, batch.ts  v2 offline
  jobs.ts              reconcile, backfill, retention hooks
  repo-scanners.ts, repo-events.ts, repo-staff.ts, repo-scans.ts, repo-gates.ts,
  repo-lookup.ts, repo-counts.ts, repo-target.ts   SQL only here
  dto.ts               row → contract mappers
src/worker/modules/nfc/                        n8
  routes.ts, service.ts, repo.ts
  gate.ts              nfcDictionary(ctx, { identity, orgId, manifest, scanCode }) | null
  keys.ts              SPKI P-256 validation, key id
```

`nfc` is its own module so `passes/builder.ts` imports the gate without a cycle through `scan` (which imports
`passes`). Every file stays under 300 lines; tests sit beside the code.

### 3.2 Shared and passkit

```
src/shared/contracts/scan.ts       device API, reasons, card, outcome, ScanTargetSchema   n8
src/shared/contracts/scanners.ts   scanners, events, staff, scan records, feed             n8
src/shared/contracts/nfc.ts        keys, status, reader test                               n8
src/shared/copy/scan.ts            SCAN_COPY: reason headlines and subs, outcome words     n8
src/shared/scan-lookup.ts          normalizeLookup                                          n8
src/shared/email.ts                maskEmail added beside normalizeEmail                    foundation (P0)
src/shared/pass-view/validity.ts   validityOf(passJson, now), extracted from normalize.ts   b
src/passkit/types.ts               ScanManifest, NfcManifest on TemplateManifest            a2
src/passkit/template/scan.ts       scanIssues, nfcIssues (beside n7's messaging.ts)         a2 (n8 writes, a2 reviews)
src/passkit/template/scan-display/ the display model, pure (DM 6.2):                        a2 (n8 writes, a2 reviews)
  schema.ts, icons.ts              ScanDisplayDocSchema and friends (passkit's first zod), SCAN_ICONS (40 ids)
  validate.ts                      scanDisplayIssues(manifest, { passJson, assetNames })
  scope.ts, condition.ts, format.ts  scope types and scopeCatalog, Cond evaluation, display filters
  render.ts, density.ts, needs.ts  renderScanDisplay, the unit budget, static needs
  presets.ts, defaults.ts, migrate.ts  PRESETS, defaultScanDisplay, migrateScanDisplay
src/shared/contracts/scan-display.ts  rendered ScanDisplaySchema (imports icons.ts only, never schema.ts)  n8
templates/starter-*                scan blocks (with `display`), barcode switch             a2
```

Nothing in `scan-display/` imports React, the worker or a colour or size: the display is direction-agnostic (D26).

### 3.3 Web

```
scan.html, public/scan.webmanifest                 the /scan entry                    n8 (integration wires vite)
src/web/scan/                                      AC §8 tree, with:
  main.tsx, app.tsx, timing.ts
  boot/      use-scan-session, pair-view, pair-confirm, pair-link, admin-scope, block-panel, staff-sheet (new)
  machine/   types, reduce*, present, ignore, deadlines, derive, store, commands, use-scan-machine
  input/     types, bus, normalize, us-keymap, wedge-detector, wedge-source, wedge-field, nfc-bridge, nfc-source
  camera/    camera, pick-camera, errors, frame-loop, roi, stability, decoder, native-decoder,
             zxing-decoder, decode-worker, worker-protocol
  platform/  audio-unlock, wake-lock, lifecycle, prefs, persist
  sound/     tones (BM §12 chirps), player
  api/       scan-api, to-fail
  offline/   db, unsure-store, hash, wipe; v2 roster, decide, queue-store, sync; v3 sw-register
  ui/        scan-shell, capsule, chips, scan-menu, live-announcer, start-panel, camera-layer (feed, reticle,
             lock outline, live pill), camera-panel, reader-stage, verdict-tint (scrim, tint, ring, desk dim),
             dock (last-scan strip, thumb row, commit pair, phone keypad tray), last-scan-strip, recent-scans,
             shift-sheet, shift-summary, keypad, approval-panel, scan.css (shell layout and tokens)
  result/    card-layer (FLIP rise, tuck, interrupt swap), result-card, verdict-band, verdict-glyph,
             identity-row (pass tile or photo, holder line, meta, chips, compact pass row), notes-slot,
             pass-sheet (the full PassCard behind the chevron), result.css, motion.css
  display/   display-panels, panel, rows-text, rows-value, rows-list, chip, icons (SCAN_ICONS → Lucide), display.css:
             paints a ScanDisplay; the designer's Scan screen canvas imports the same components
  lookup/    lookup-sheet, lookup-results
  desk/      desk-panel, action-area (stepper, presets, iPad keypad, review), stepper, review
  buddy/     scan-buddy (dock seat, XL, `card` prop), beat-map, beats.css, props.tsx (BM §2.2)
  dev/       test-hook (dev builds only)
src/web/admin/scanning/                            n8 (replaces admin/scanners/)
  scanning-page.tsx, scanners/*, events/*, staff/*, scans/*, pairing-face.tsx, undo-confirm.ts
src/web/routes/admin/scanning/                     n8 (replaces routes/admin/scanners/)
  index.tsx (?tab=), scanners.$scannerId.tsx, events.$eventId.tsx
```

Deleted: `src/web/routes/scan.tsx`, `src/web/scan/scan-page.tsx`, `src/web/admin/scanners/`, `src/web/routes/admin/scanners/`.

The visual direction lives only in `ui/`, `result/`, `display/`, `desk/` (geometry, tokens, motion) and `buddy/`.
`machine/`, `api/` and the contracts carry no layout, so "A at the door, B at the desk" would swap views, not data.

Touches owned by others (additive): designer `section-scan.tsx`, `ops-scan.ts`, `section-nfc.tsx`, `ops-nfc.ts`, the
**Scan screen** mode in `designer/scan/**` and its hooks in `model`, `apply`, `reducer`, `targets`, `outline`,
`designer`, `designer-page`, `api`, `section-inputs` (n5; DM §10.2); `template-overview.tsx`, `versions-panel.tsx` (i);
identities `nfc-card.tsx`, `reader-key-dialog.tsx`, `reader-test-dialog.tsx` (n2); Sync log (n1/i); overview (h);
audience (n7); portal pass header (j); `ui/art` beat API and entity art (h0); `lib/{nav,entities,status,actions}.ts`
(h0). Section 11 and 16 list each.

---

## 4. Contracts

Names and fields. All in zod, re-exported by `contracts/index.ts`. Ids are `IdSchema` (UUIDv7), times are integer ms.

### 4.1 Template manifest (`src/passkit/types.ts`)

```ts
export type ScanActionKind = 'check_in' | 'add' | 'take' | 'set' | 'use_up';
export type ScanRole = 'door' | 'desk' | 'manager';
export type ScanRepeat = 'once' | 'daily' | 'cooldown' | 'always';

export interface ScanAction {
  id: string;                    // ^[a-z][a-z0-9_]{0,31}$, unique; scans and gates key on it
  label: string;                 // 1-24 chars, unique
  kind: ScanActionKind;
  input?: string;                // add, take: number input. set: scalar input.
                                 // check_in: optional record input (number: +1 visit; date-time: now)
  amount?: number | { max: number; presets?: number[]; default?: number };  // add, take. Fixed, or staff enter 1..max
  value?: Json;                  // set: fixed value. Absent: staff pick (enum) or type, validated by the input schema
  repeat?: ScanRepeat;
  cooldownMinutes?: number;      // repeat 'cooldown': 1-10080
  minRole?: ScanRole;
  confirm?: boolean;             // review before applying
  confirmAbove?: number;         // review when amount > n
  allowAgain?: boolean;          // check_in: Let in again is offered (default true)
  rewardLabel?: string;          // take: "Free coffee", 1-24
  notify?: boolean;              // lock-screen message; spends the push budget. Default false
  allowOnConnected?: boolean;    // may change a connection-owned input; it becomes manual. Default false
}
export interface ScanManifest {
  actions: ScanAction[];                                             // 1-6
  lookup?: { input: string };                                        // typed member, card or ticket number
  window?: { from?: string; until?: string; earlyMinutes?: number; lateMinutes?: number };  // date-time inputs, 0-1440
  flags?: { input: string; label: string; equals?: string[]; stop?: boolean }[];  // ≤ 4; behaviour, system chip slot
  display?: ScanDisplayDoc;                                          // the result screen (4.6, DM §6.1); default at read
}
// Removed in revision 2026-11-04: `values` (now Loyalty and Balance panels) and `identity` (now `display.photo`,
// the meta line and chips). The card's system `values` are derived from action inputs (4.2).
// Inputs schema: `"x-scan": "desk" | "manager" | "hidden"` beside `x-label` (4.6 role filter).
export interface NfcManifest { enabled: boolean; requiresAuthentication?: boolean }
// TemplateManifest gains: scan?: ScanManifest; nfc?: NfcManifest
```

Defaults are applied at read by `scanOf(manifest)` (`modules/scan/rules.ts`), never persisted:

| | check_in | add | take | set | use_up |
| --- | --- | --- | --- | --- | --- |
| `repeat` | `once` | `cooldown` 5 min | `always` | `always` | `once` (implicit) |
| `minRole` | door | desk | desk | manager | desk |
| `confirm` | false | false | true | true | true |
| `amount` | — | 1 | 1 | — | — |
| armable (ready action) | sticky | sticky if fixed and no confirm; one-shot if asked | no | no | no |

No `scan` block means `[{ id: 'check_in', label: 'Check in', kind: 'check_in' }]`. No `display` means
`defaultScanDisplay(manifest, passJson)` (4.6), applied at read and never persisted.

**Validator** (`scanIssues`, `nfcIssues`, `scanDisplayIssues`; one call each in `validateManifest`; the display's
codes are `SCAN_DISPLAY_*`, DM §6.3). Errors block upload and save:
`SCAN_SHAPE`, `SCAN_TOO_MANY`, `SCAN_ID_INVALID`, `SCAN_ID_DUPLICATE`, `SCAN_LABEL_INVALID`, `SCAN_LABEL_DUPLICATE`,
`SCAN_INPUT_MISSING`, `SCAN_INPUT_NOT_NUMBER`, `SCAN_AMOUNT_RANGE` (outside the input's bounds, non-integer for an
integer input, presets outside 1..max), `SCAN_VALUE_INVALID` (fails the input schema), `SCAN_WAIT_RANGE`,
`SCAN_WINDOW_INPUT` (not a `date-time` input), `SCAN_LOOKUP_INPUT` (not string or integer), `SCAN_FLAGS`, `NFC_SHAPE`, `NFC_IN_PASS_JSON` (the template's own `pass.json` has `nfc`; the platform owns it now).
Warnings: `SCAN_CODE_NOT_IN_BARCODE` (a `use_up` on a template whose barcode isn't `{{pass.scanCode}}`, or a
static barcode), `SCAN_NOTIFY_BUDGET` (`notify` on `add`), `NFC_STYLE` (not `storeCard` or `eventTicket`). Info:
`NFC_IDENTITY` (NFC is off for passes signed by {identity}).

### 4.2 Device API (`src/shared/contracts/scan.ts`)

```ts
ScanMethodSchema       = enum ['camera', 'wedge', 'nfc', 'manual']
ScanActionKindSchema   = enum ['check_in', 'add', 'take', 'set', 'use_up']
ScanRoleSchema         = enum ['door', 'desk', 'manager']
ScanDirectionSchema    = enum ['in', 'out']
CodeFormatSchema       = enum ['qr', 'pdf417', 'aztec', 'code128', 'code39', 'codabar', 'ean13', 'itf']
ScanOutcomeKindSchema  = enum ['ok', 'heads_up', 'refused', 'ready']
ScanReasonSchema       = enum [
  // refused (red)
  'not_found', 'ambiguous', 'test_pass', 'live_pass', 'not_accepted', 'wrong_event',
  'removed', 'voided', 'expired', 'no_balance', 'managed_elsewhere', 'limit_reached',
  // refused, access templates (19.5; P0-5)
  'zone_not_included', 'outside_hours', 'guest_expired', 'guest_visits_used', 'suspended',
  // heads_up (amber)
  'already_done', 'cooldown', 'not_yet_valid', 'ended', 'capacity_full', 'check_required',
  'needs_approval', 'stale', 'in_progress',
  // ready
  'choose',
]
// Client-only, never on the wire: system {network, timeout, unconfirmed, still_unconfirmed, server, rate_limited},
// queued {saved_offline}, refused {add_link}. They live in src/web/scan/machine/types.ts.

ScanInputSchema = union [
  { code: string 1..1024, method: ScanMethodSchema },
  { passId: IdSchema, method: literal 'manual' },
]
ScanAdminScopeSchema = { orgId: IdSchema, eventId?: IdSchema, templateIds?: IdSchema[] ≤ 20, timeZone: TimeZoneSchema }
ScanApprovalSchema   = { staffId: IdSchema, pin: string /^\d{6}$/ }

ScanResolveRequestSchema = { idempotencyKey: UuidV7Schema, input: ScanInputSchema, clientTs, dayStart?, scope?: ScanAdminScopeSchema }
ScanActRequestSchema = {
  idempotencyKey, input, actionId: string | literal 'auto',
  amount?: number, value?: JsonSchema, direction?: ScanDirectionSchema,
  overrideOf?: IdSchema,          // the heads-up scan being overridden
  confirmed?: boolean,            // stop flags acknowledged
  expectedVersion?: number,       // set: the card's version
  group?: literal 'bundle',
  approval?: ScanApprovalSchema,
  clientTs, dayStart?, scope?,
}
ScanUndoRequestSchema = { idempotencyKey, approval?: ScanApprovalSchema }

ScanPreviousSchema = { scanId, at, scannerName, staffName: string | null, actionLabel, override: boolean }
ScanValueSchema    = { input, label, before: Json | null, after: Json | null, goal: number | null, format: 'number' | 'currency' | 'text', currency?: string }
ScanCardActionSchema = {
  id, label, kind, available: boolean,
  lock: null | 'role' | 'approval' | 'max',   // why it's locked; 'approval' = a Manager PIN unlocks it
  reason: ScanReasonSchema | null,            // e.g. cooldown, no_balance
  amount: { fixed: number } | { max: number, presets: number[], default: number | null } | null,
  confirm: boolean, confirmAbove: number | null, cooldownRemainingMs: number | null,
  armable: 'sticky' | 'once' | null, rewardLabel: string | null,
}
ScanCardSchema = {
  passId, version, mode, title, subtitle: string | null,
  template: { id, name, style }, status: enum ['active', 'voided', 'expired', 'removed'],
  validFrom: number | null, validUntil: number | null,
  flags: { label, tone: 'warning' | 'neutral', stop: boolean }[] ≤ 4,
  values: ScanValueSchema[] ≤ 3,              // system data from action inputs (label from x-label, goal from a take amount):
                                              // pickers, headline subs, the desk draft preview; not a display
  actions: ScanCardActionSchema[] ≤ 6,
  display: ScanDisplaySchema,                 // screen 'ready' (4.6); holder line and photo URL (+ `?g=` grant) in `display.identity`.
                                              // The desk panel paints it; a result card never does (DM 1.11 rule 13)
  lastScans: { scanId, at, actionLabel, outcome, scannerName, undoable: boolean }[] ≤ 3,
  bundle: { id, name, size, checkedIn: number | null } | null,
  door: { state: 'in' | 'out' | null } | null,
  passView: { passJson: JsonSchema, assetBaseUrl: string, assetGrant: string, assetNames: string[] },
    // passJson minus barcode, barcodes, nfc, authenticationToken, webServiceURL, serialNumber
}
ScanCountsSchema = { today: int, event: { arrived: int, inside: int | null, expected: int, capacity: int | null } | null, asOf: number, configRev: number }
ScanOutcomeSchema = {
  scanId: IdSchema | null, kind: ScanOutcomeKindSchema, reason: ScanReasonSchema | null, replay: boolean,
  action: { id, label, kind } | null, card: ScanCardSchema | null, previous: ScanPreviousSchema | null,
  template: { name, style } | null,           // set whenever a pass was found; on test_pass/live_pass the only identity
  at: number | null, cooldownRemainingMs: number | null, value: ScanValueSchema | null, flags: string[],
  overridable: boolean, approvals: boolean,   // a Manager PIN can unlock this heads-up / the org has active managers
  group: { total, done, already, refused } | null,
  counts: ScanCountsSchema, milestone: enum ['count', 'all_in', 'reward'] | null, undoUntil: number | null,
  display: ScanDisplaySchema | null,          // the outcome's screen (ok, heads_up, refused) with post-effect values;
                                              // null for system screens and unknown passes, so refused bodies for
                                              // unknown codes stay byte-equal across orgs
}

ScanSessionSchema = {
  principal: enum ['scanner', 'admin'], state: enum ['ready', 'staff_required', 'not_open', 'closed', 'unassigned'],
  scanner: { id, name, kind, mode, orgId, orgName, timeZone, settings: ScannerSettingsSchema } | null,
  admin: { name, orgs: { id, name }[] } | null,   // admin principal: org picker
  event: { id, name, opensAt, closesAt, timeZone, reentry: boolean, note: string ≤ 140 | null } | null,
                                                   // note: the event's staff note (Start panel, heads_up, refused)
  templates: { id, name, style, formats: CodeFormatSchema[], actions: { id, label, kind }[] }[],
  formats: CodeFormatSchema[],                     // union of the accepted templates' barcode formats
  staff: { id, name, role } | null,
  staffList: { id, name, role }[] | null,          // only when staffSignIn is on
  approvals: boolean, csrfToken: string | null, undoWindowMinutes: int, counts: ScanCountsSchema,
}
ScanPairRequestSchema   = { code: string 10..16 }
ScanPairPreviewSchema   = { scannerName, orgName, mode }
ScanStaffSignInSchema   = { staffId, pin }
ScanLookupRequestSchema = { q: string 1..120, scope? }
ScanLookupRowSchema     = { passId, title, subtitle, templateName, status, maskedEmail: string | null, photoUrl: string | null, doorState: 'in' | 'out' | null, lastScanAt: number | null }
  // photoUrl only when the template's display sets `photo` and its minRole admits the actor's role
ScanLookupResultSchema  = { items: ScanLookupRowSchema[] ≤ 10, more: boolean }
ScanRecentSchema        = { items: { scanId, at, outcome, reason, actionLabel, title: string | null, value, undoable }[] ≤ 20 }
ScanSummarySchema       = { from, to, total, ok, headsUp, refused, undone, byAction: { actionId, label, count, amount }[], firstAt, lastAt }
// v2
ScanRosterSchema        = { entries: { h: string /^[0-9a-f]{32}$/, status: 'active' | 'voided' | 'removed', state: 'in' | 'out' | null }[], cursor: string | null, asOf, validUntil }
ScanBatchRequestSchema  = { items: { idempotencyKey, code, method, clientTs, direction?, override?: boolean }[] 1..50 }
  // An offline heads-up never reached the server, so a queued override carries `override: true`, not `overrideOf`.
  // Allowed only when the scanner's letInAgain is 'anyone' (no PIN offline); else the item answers needs_approval.
ScanBatchResultSchema   = { items: { idempotencyKey, outcome: ScanOutcomeSchema (card null) }[] }
// Shared with broadcasts and the passes list
ScanTargetSchema = union [ { eventId: IdSchema, checkedIn: boolean }, { noScanDays: literal 30 | literal 90 } ]
```

### 4.3 Console API (`src/shared/contracts/scanners.ts`)

```ts
ScannerKindSchema     = enum ['device', 'terminal', 'display']        // display: 18.1 (P0-4)
DeviceRoleSchema      = enum ['scan', 'customer', 'monitor']         // ScannerSchema.deviceRole; accepts null for display
ScannerSettingsSchema = { flow, defaultActionId: string | null, roleWithoutSignIn: 'door' | 'desk', staffSignIn, letInAgain,
                          reader: 'none' | 'barcode' | 'nfc', lookup, offline, dailyAmount: int 1..10_000_000 | null }
ScannerAcceptsSchema  = union [ { eventId: IdSchema }, { templateIds: IdSchema[] 1..20 } ]
ScannerSchema = { id, orgId, mode, kind, name, accepts: ScannerAcceptsSchema, settings, timeZone,
                  status: 'not_paired' | 'paired' | 'revoked', online: boolean, pairedAt, pairedLabel, lastSeenAt,
                  expiresAt, staff: { id, name } | null, today: int, createdAt }
CreateScannerSchema   = { orgId, name: PlainLineSchema(40), kind, accepts, settings?: Partial, timeZone }   // mode from modeOf
UpdateScannerSchema   = { name?, accepts?, settings? }
ScannerModeSchema     = { mode: ModeSchema }
ScannerListQuerySchema= { orgId?, status?, eventId?, q?, cursor?, limit? }
ScannerPairingSchema  = { code, url, expiresAt }
ScannerPairingStateSchema = { state: 'waiting' | 'paired' | 'expired', device: { label, at } | null }
TerminalTokenSchema   = { token, expiresAt }
ScannerStatsSchema    = { days: { day, ok, headsUp, refused }[], methods: Record<ScanMethod, int>, lastSeenAt }

ScanEventSchema = { id, orgId, mode, name, templateIds, match: { input, values: string[] 1..20 } | null,
                    opensAt, closesAt, timeZone, capacity: int | null, reentry: boolean,
                    note: PlainTextSchema(140) | null,   // staff note; no other display field on events (D21)
                    status: 'upcoming' | 'live' | 'ended' | 'archived', arrived: int, expected: int, scanners: int }
CreateScanEventSchema, UpdateScanEventSchema   // closesAt > opensAt; templates must have a check_in action; note optional
ScanEventAssignSchema = { scannerIds: IdSchema[] ≤ 200 }
ScanEventLiveSchema   = { arrived, inside, expected, capacity, perMinute: { at, ok, headsUp, refused }[] (30),
                          scanners: { id, name, ok, lastScanAt, online }[], reasons: { reason, count }[],
                          latest: ScanRecordSchema[] ≤ 20 }

ScanStaffSchema       = { id, orgId, name, role, pinSetAt, locked: boolean, disabledAt, today, lastScan: { at, scannerName } | null }
CreateScanStaffSchema = { orgId, name: PlainLineSchema(40), role }; UpdateScanStaffSchema = { name?, role?, disabled? }
StaffPinSchema        = { pin }    // shown once

ScanRecordSchema = { id, at, outcome, reason, kind, actionId, actionLabel, direction, passId, passTitle,
                     templateId, templateName, eventId, eventName, scannerId, scannerName, staffId, staffName,
                     approvedBy: string | null, method, amount, before, after, passVersion, override: boolean,
                     offline: boolean, actor: { type: 'scanner' | 'user', id }, undoneAt, undoneBy, undoes }
ScanListQuerySchema = { orgId?, scannerId?, staffId?, eventId?, passId?, outcome?, reason?, from?, to?, cursor?, limit? ≤ 100 }
ScanFeedRowSchema   = { id, at, passId, externalId, templateId, eventId, actionId, kind, outcome, reason, amount,
                        before, after, method, scannerId, scannerName, undoneAt }   // API keys: no titles, no names of staff
```

### 4.4 NFC (`src/shared/contracts/nfc.ts`)

```ts
VasKeySchema       = { id, identityId, orgId, keyId /^[0-9a-f]{8}$/, state: 'active' | 'retiring' | 'retired',
                       createdAt, activatedAt, retiredAt, passCount: int, passesLeft: int | null }
CreateVasKeySchema = { identityId, orgId, publicKey: string }   // base64 SPKI, validated as P-256
NfcStatusSchema    = { enabled: boolean, identities: { id, label, nfcEnabled, keys: VasKeySchema[] }[] }
NfcTestRequestSchema = { identityId, orgId, message: string 1..64 }
NfcTestResultSchema  = { pass: { id, title, templateName } | null }
```

### 4.5 Changes to existing contracts

| File | Change |
| --- | --- |
| `contracts/common.ts` | `ApiScopeSchema` + `scans:read` |
| `contracts/events.ts` | kinds `scan.checked_out`, `scan.heads_up`, `scan.undone`; group `scans` |
| `contracts/settings.ts` | platform: `retention.scansDays` (30..3650, 396), `scan.undoWindowMinutes` (1..60, 10), `scan.lookupsPerHour` (20..2000, 200), `nfc.enabled` (false) |
| `contracts/broadcasts.ts` | `BroadcastTargetSchema.scan?: ScanTargetSchema` |
| `contracts/passes.ts` | list filter `scan?: ScanTargetSchema` |
| `contracts/metrics.ts` | `totals.scans`, `totals.scanRefused`, `series.scans`, `setup.scanners`, `live: { eventId, name, arrived, expected, ratePerMin }[] ≤ 3` |
| `contracts/me.ts` | `MyPassSchema.lastScan: { kind: 'checked_in' \| 'scanned', at } \| null` (later slice) |
| `contracts/identities.ts` | `IdentitySchema.nfcKeys: VasKeySchema[]` |
| `contracts/templates.ts` | `SaveVersionRequest.activate: boolean \| 'display-only'`; `SaveVersionResponse.displayOnly: boolean`; `TemplateVersionSchema.displayOnly` for the versions list badge (4.6, D25) |
| `contracts/scan-display.ts` (new) | the rendered `ScanDisplaySchema` (DM §5.5), re-exported by `contracts/index.ts` |

### 4.6 Scan display (`src/passkit/template/scan-display/`, `src/shared/contracts/scan-display.ts`)

DM is the full model (sections 1-6). What every builder needs:

**Screens.** A display renders for one of `ready` (desk card), `ok`, `heads_up`, `refused`, picked from the outcome.
System-only screens (network, server, rate limit, saved offline, client-local refusals) have `display: null`.

**Slots and owners** (top to bottom on every screen; the client places them, the model fixes order and owner):

| Slot | Owner | `ready` | `ok` | `heads_up` | `refused` |
| --- | --- | --- | --- | --- | --- |
| Tint and ring, verdict band (glyph, headline, sub), hold rail | system | none (camera dims) | yes | yes | yes |
| Custom icon (verdict glyph as a badge) and custom title (verdict word as eyebrow) | template `header.icon`, `header.title` | — | yes | — | — |
| Identity row: pass tile or photo, **holder line** (always shown) | system; the doc chooses the sources (`holder`, `photo`) | yes | yes | yes | compact row when found |
| Meta line under the holder line | template `header.subtitle`, else the pass subtitle | yes | yes | yes | — |
| Flags, then chips | flags system (`scan.flags`, **No photo**); chips template (≤ 2) | yes | yes | yes | — |
| Panels (0-2 shown of ≤ 6 defined; 1 while an amount control is open) | template `panels` | yes | yes | yes | — |
| Notes | template `notes.staff` / `notes.refused` (literal); then the event note | staff | staff | staff, event | refused, event |
| Action area (card footer and dock), last-scan strip, buddy | system | yes | yes | yes | yes |

**Authored doc** (`ScanDisplayDoc`, DM §6.1): `{ v: 1, holder?, photo?, currency?, header, variants? (≤ 8, first match
wins, header only), panels? (≤ 6), notes? }`. A panel is `{ id, preset?, title?, icon?, tone?, rows (1-6), on?,
actions?, when?, minRole? }`. Twelve row types: `heading`, `field`, `big`, `columns` (2-4 items), `progress`, `money`,
`history`, `image` (thumbnail, strip), `chips`, `list`, `note`, `divider`. Every element has `id`, `when`, `minRole`.
Eight presets (Membership, Loyalty, Balance, Ticket, Offer, Access, Details, Note) are factories that write ordinary
rows. Texts are literal, `{{path|filter}}` interpolations (strict: any empty part empties the text), or plurals.
Limits: 16 KB serialized; density ≤ 5 row units per panel and ≤ 6 per result with 1 per panel frame, minus a
per-screen header cost (custom title 2, a 2-line title 1 more, `heads_up` 2, photo 1, a second chip line 1, staff note 1). Over the budget on
`ok` is a save error; on `heads_up` and `ready` the renderer cuts trailing rows (DM §1.6, §6.2). `header.title` is
literal text plus, at most, the holder's name (`{{holder.firstName}}` or `{{holder.name}}`; no other binding, no
filter), or a plural; ≤ 2 lines (28 graphemes); the verdict-word check covers the literal part at save; a name token
needs a `holder` source that can hold a name (a string input without `enum`, or a field) and, at render, a value of
1-3 words of letters with no verdict word, else the title is empty and the band shows the system headline; `heads_up`
and `refused` keep the system headline; `holder` is one path (DM R16, §1.3).

**Rendered contract** (`ScanDisplaySchema`, DM §5.5): `{ v, screen, templateVersion, variant, identity: { holder,
initials, photo }, header: { icon, title, titleLines, meta, chips }, panels, notes }`; group rows carry `oneLine`, the compact-width
layout verdict, so the client never measures text. No geometry, colour or size anywhere (D26).

**Server pipeline** (`modules/scan/display.ts` → `renderScanDisplay`, DM §5.1): outcome decided → screen →
`compiledDisplay(template active version)` (isolate LRU, 64 entries; versions are immutable) → drop elements whose
`minRole` exceeds the role → `buildScope(role, needs)` → identity → (refused: identity and `notes.refused`, stop) →
first matching variant → header (heads_up drops icon and title) → panels filtered by `on`, `actions`, `when`, rendered,
emptied ones dropped, first 2 kept → `oneLine` → sanitize, cap and truncate by grapheme. Rendered displays are never
cached or logged. A throw logs `SCAN_DISPLAY_RENDER` (ids only) and returns `defaultScanDisplay`'s render; a stored
active version that fails validation logs `SCAN_DISPLAY_INVALID`. Terminals get identity, header and notes, no panels.

**Binding scope** (DM §3.1): roots `holder` (`name`, `firstName`, `initials`), `inputs` (after defaults, filtered by `x-scan`), `fields` (front and back
values as Wallet formats them, from the current `pass.json`), `pass` (`title`, `subtitle`, `status`, `statusLabel`,
`validFrom`, `validUntil`, `createdAt`, `version`, `templateName`, `style`; `externalId` desk and up), `scan` (this
request: outcome, reason, action, amount, before, after, previous), `history`, `event`, `scanner`, `lookups`, `now`.
Formatting (`date`, `time`, `datetime`, `day`, `ago`, `count`, `money`, `upper`) runs on the server in the actor's time
zone and the scanner's locale.

**Role filter, before evaluation** (DM §5.2): `minRole` on panels, rows, items and chips is applied to the doc; the
scope loses inputs annotated `x-scan` above the role and the fields bound to them. **Never in scope, for any role,
admins included** (DM §1.11 rule 8): `pass.scanCode`, the barcode message, `authenticationToken`, `webServiceURL`, the
serial, the download token; inputs with `format: email | uri` or `x-widget: email | tel | url`; inputs with a name
segment `email`, `phone`, `tel`, `mobile`, `password`, `passcode`, `secret`, `token` or `pin` unless explicitly
annotated `x-scan`; and every field whose value references any of these or a `pass.*` binding.
Referencing one is the validator error `SCAN_DISPLAY_SECRET`. A path that was removed resolves empty, so its element
hides: there is no way to leak by binding.

**History** (DM §1.10), computed from `scans` within `retention.scansDays`, excluding undone scans and undo rows:

| Path or row | Source |
| --- | --- |
| `history.lastVisit.at`, `.where`; `history.visits.today/.week/.month/.year/.total` (cap 9,999) | `ok` check-ins, `scans_pass_ok` |
| `history.checkedInAt`, `history.inside` | `scan_gates` (already read by the gate) |
| `history.scans.today/.total`, `history.lastScan.*` | `scans_pass_ok`, `scans_pass` |
| `history` row `source: 'value'` (the ledger): `at`, signed `amount`, `after`, `where`, `label` (the action's label) | the last N `ok` `add`/`take`/`set` scans on that input, over the last 50 rows |
| `history.ledger.<input>.last.*`, `.month.in`, `.month.out` | the same rows; one conditional-sum statement |
| **Changed elsewhere** | when the pass's current value differs from the newest listed scan's `after`: one row with the signed difference, no time |

`where` is the scanner's current name, **Console** for an admin session, **Removed scanner** when the row is gone.
History rows never show staff names or item names (scans carry no memo, and none is planned). History statements run only when the
compiled doc's `needs` lists them, inside the existing card or counts batch: statements, never extra round trips.

**Versions** (D25, DM §2.5): every save that changes `scan.display` makes an immutable template version.
`template_versions.build_key` = SHA-256 of `pass.json`, assets and the manifest without `scan.display`,
`description` and `previewOnlyAssets`, computed on insert; `NULL` on old rows means "assume it differs". Stale means
the pinned version's `build_key` differs from the active one's (or either is `NULL`). A save with `activate:
'display-only'` activates only when the build keys match; the response says `displayOnly` and `activated`. The stale
job then moves nothing. Scanners read the display from the **active** version, never the pass's pinned one; a verdict
already on screen doesn't change.

**Events** (D21): no display fields except `note` (≤ 140, plain text). It is not part of `ScanDisplay`; it travels in
`ScanSessionSchema.event.note` and the client puts it in the notes slot on `heads_up` and `refused`, and on the Start
panel.

**Safety rules** (DM §1.11, each enforced in code and tested): no display field reaches the verdict; a custom icon only
on `ok` and always with the verdict badge; a custom title keeps the verdict word as the eyebrow and in the
announcement; refusals show only `notes.refused`; a result card paints `ScanOutcome.display` only; the band and
identity row never move (overflow scrolls the body); no controls, links, URLs, phone numbers or emails in any row; the
icon set and chip tones exclude verdict shapes and colours; role visibility; secrets never in scope; caps and
sanitizing after rendering (text nodes only, `dir="auto"`); no display motion of its own; fail safe.

---

## 5. Routes

All JSON, zod-validated, problem+json errors, `Cache-Control: no-store` on scan routes. Registered with
`register(router, tag, spec, handler)`; OpenAPI tags `scan`, `scanners`, `scan-events`, `scan-staff`, `scans`, `nfc`.

### 5.1 Device API (`/api/v1/scan`)

| Method and path | Guard | Body or query → result |
| --- | --- | --- |
| `POST /pair/preview` | public, `sameOriginOnly`, `RL_SCAN_PAIR` | `{ code }` → `ScanPairPreview` |
| `POST /pair` | same | `{ code }` → `ScanSession` + cookie |
| `POST /unpair` | scanner cookie or none | → 204, always |
| `GET /session` | scan actor (staff not required) | admin: `?orgId&eventId&templateIds&timeZone` → `ScanSession` (the same query scopes an admin on every GET below, assets included; 2.5) |
| `POST /staff`, `DELETE /staff` | scanner (staff not required) | `ScanStaffSignIn` → `ScanSession` |
| `POST /resolve` | scan actor | `ScanResolveRequest` → `ScanOutcome` (`ready`, `heads_up`, `refused`) |
| `POST /actions` | scan actor | `ScanActRequest` → `ScanOutcome` |
| `POST /scans/{scanId}/undo` | scan actor | `ScanUndoRequest` → `ScanOutcome` |
| `GET /scans` | scan actor | `?limit≤20` → `ScanRecent` (this actor's) |
| `POST /lookup` | scan actor, `lookup` on, `RL_SCAN_LOOKUP` | `ScanLookupRequest` → `ScanLookupResult` |
| `GET /stats` | scan actor; touches `last_seen_at` | `?dayStart` → `ScanCounts` |
| `GET /summary` | scan actor | `?since` (≤ 24 h back) → `ScanSummary` |
| `GET /passes/{passId}/assets/{name}?g=` | scan actor + a valid grant | image |

**Asset grant.** A desk card (`ready`) and a lookup row write no `scans` row, so "this actor scanned it" can't gate
assets. Every card and lookup row carries `g` = base64url(HMAC-SHA256(`derivedHmacKey(env, 'scan-asset')`,
`actorKey ‖ passId ‖ exp`) ‖ exp), `exp` = now + 1 h. The route recomputes it for the requesting actor: stateless, no
D1 read, useless without that actor's credential. Request logs carry the route pattern only, so `g` is never logged.
| `GET /roster` (v2) | scanner with `offline`, accepts an event | `?cursor` → `ScanRoster` |
| `POST /batch` (v2) | scanner with `offline` | `ScanBatchRequest` → `ScanBatchResult` |

Stations add `/live`, `/live/events`, `/live/snapshot`, `/role/options` and `/role` (18.6). Every route above
answers 403 `SCREEN_ONLY` to a Customer screen or Desk monitor, except `/session` and `/unpair`.

### 5.2 Console and integration

All `requireAdmin` (mode from the header, CSRF) unless marked. Lists filter by `modeOf` and the org scope; by-id
routes assert the org (`assertOrg`).

| Method and path | Notes |
| --- | --- |
| `GET`, `POST /api/v1/scanners` | create returns the scanner and, for a device, a pairing |
| `GET`, `PATCH /api/v1/scanners/{id}` | |
| `POST /api/v1/scanners/{id}/pairing`, `GET …/pairing` | new code; poll state |
| `POST /api/v1/scanners/{id}/pair-here` | sets the scanner cookie on this browser |
| `POST /api/v1/scanners/{id}/token` | terminal: new token, shown once |
| `POST /api/v1/scanners/{id}/revoke` | |
| `POST /api/v1/scanners/{id}/mode` | Go live / Move to Test mode; a test event is detached first |
| `POST /api/v1/scanners/{id}/sample-pass` | test scanners only: one test pass of the first accepted template, sample inputs, no holder |
| `GET /api/v1/scanners/{id}/stats` | `?range=7d\|30d` |
| `GET`, `POST /api/v1/scan-events`; `GET`, `PATCH /{id}`; `POST /{id}/archive`; `POST /{id}/scanners` | assign moves scanners to the event; archive detaches them (`unassigned`). Templates, scanners and events must share the org (else 404) and scanners the event's mode (else 422 `SCAN_MODE_MISMATCH`) |
| `GET /api/v1/scan-events/{id}/live`, `/summary` | live polled every 5 s while visible |
| `GET`, `POST /api/v1/scan-staff`; `PATCH /{id}`; `POST /{id}/pin` | PIN shown once |
| `GET /api/v1/scans` | admin: `ScanRecord` rows. **API key `scans:read`** (`requireApiKeyOrAdmin('scans:read')`): `ScanFeedRow`, org-scoped keys see their org, mode from the key |
| `GET /api/v1/scans/{id}` | admin |
| `GET /api/v1/scans/export` | admin; CSV; range ≤ 92 d, ≤ 100k rows; `scan:export` counter; audited |
| `POST /api/v1/scans/{id}/undo` | admin; ≤ 30 d |
| `GET /api/v1/nfc` | status |
| `POST /api/v1/nfc/keys` | `CreateVasKey`; becomes active; the previous active key of (identity, org) becomes retiring and a scoped reissue starts |
| `POST /api/v1/nfc/keys/{id}/retire` | when `passesLeft = 0`, or with `force: true` (typed confirm in the UI) |
| `POST /api/v1/nfc/test` | `NfcTestRequest`; resolves in that org; the message is never logged |
| `PATCH /api/v1/settings` (existing) | `nfc.enabled` and the scan settings |
| `PATCH /api/v1/identities/{id}` (existing) | `nfcEnabled` (n2's route; audits `identity.nfc_change`) |
| `POST /api/v1/templates/{id}/versions` (existing) | the manifest carries `scan.display`; `activate: 'display-only'` activates when the build keys match (4.6); audit `template.version_activated` with `displayOnly: true` |
| `GET /api/v1/scan-display/preview?templateId&passId&role` | M3. The designer's real-pass sample: returns the role-filtered **scope** (never a rendered display), from the pass's current data; org and mode asserted; `no-store`; audited `scan_display.preview` with ids only |

### 5.3 Web routes

| URL | Page |
| --- | --- |
| `/scan` (own entry) | the scanner; `#pair=` and, for admins, `?event=` are read once at boot |
| `/admin/scanning?tab=devices\|events\|zones\|staff\|scans` | Scanning (2026-11-05: **Devices** replaces Scanners, `?tab=scanners` redirects; **Zones** added, 19.3) |
| `/admin/scanning?tab=scans&scannerId&staffId&eventId&outcome&reason&from&to` | the scans log, filters in the URL |
| `/admin/scanning/scanners/$scannerId` | scanner detail |
| `/admin/scanning/events/$eventId` | live event dashboard |
| `/admin/identities/$id` | NFC card (n2) |

Admin links into the scanner are plain `<a href="/scan…">` (a full document load).

---

## 6. Data model and migrations

Stations add `0019_scan_stations.sql` (18.7) and Access cards `0020_scan_access.sql` (19.7); both are additive and
need only the P0 amendment to `0014` below (`scanners.kind` + `display`, `device_role`).

### 6.1 `migrations/0014_scan.sql`

Independent of 0013, 0015 and 0016 (wrangler applies missing names in any order). Adds columns and indexes to
`passes`, never rebuilds it. Rebuilds only `audit_log`, which nothing references; 0013, 0015 and 0016 don't touch it
(checked on `150e0ee`).

```sql
-- Scanner: events, staff, scanners, scans, gates, NFC reader keys, desk lookup; audit gains the scanner actor.

CREATE TABLE scan_events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  name TEXT NOT NULL,
  match_input TEXT,
  match_values TEXT CHECK (match_values IS NULL OR json_valid(match_values)),
  opens_at INTEGER NOT NULL,
  closes_at INTEGER NOT NULL,
  time_zone TEXT NOT NULL,
  capacity INTEGER CHECK (capacity IS NULL OR capacity > 0),
  reentry INTEGER NOT NULL DEFAULT 0 CHECK (reentry IN (0, 1)),
  note TEXT CHECK (note IS NULL OR length(note) <= 140),   -- staff note; the only display-adjacent event field
  expected INTEGER,                -- cached denominator, refreshed at most once a minute
  expected_at INTEGER,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  CHECK (closes_at > opens_at),
  CHECK ((match_input IS NULL) = (match_values IS NULL))
);
CREATE INDEX scan_events_org ON scan_events (org_id, mode, opens_at DESC);
CREATE INDEX scan_events_created_by ON scan_events (created_by);

CREATE TABLE scan_event_templates (
  event_id TEXT NOT NULL REFERENCES scan_events (id) ON DELETE CASCADE,
  template_id TEXT NOT NULL REFERENCES templates (id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, template_id)
);
CREATE INDEX scan_event_templates_template ON scan_event_templates (template_id);

CREATE TABLE scan_staff (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('door', 'desk', 'manager')),
  pin_hash TEXT NOT NULL,          -- HMAC-SHA256(K_pin, id:pin)
  pin_set_at INTEGER NOT NULL,
  disabled_at INTEGER,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX scan_staff_org_name ON scan_staff (org_id, name COLLATE NOCASE) WHERE disabled_at IS NULL;
CREATE INDEX scan_staff_org ON scan_staff (org_id, role, name COLLATE NOCASE);
CREATE INDEX scan_staff_created_by ON scan_staff (created_by);

CREATE TABLE scanners (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  kind TEXT NOT NULL CHECK (kind IN ('device', 'terminal', 'display')),   -- display: a screen (18.1)
  device_role TEXT NOT NULL DEFAULT 'scan' CHECK (device_role IN ('scan', 'customer', 'monitor')),
  name TEXT NOT NULL,
  event_id TEXT REFERENCES scan_events (id) ON DELETE SET NULL,
  settings TEXT NOT NULL CHECK (json_valid(settings)),
  time_zone TEXT NOT NULL,
  token_prefix TEXT UNIQUE,
  token_hash TEXT,
  csrf_secret TEXT,
  pair_code_hash TEXT UNIQUE,
  pair_expires_at INTEGER,
  pair_created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  paired_at INTEGER,
  paired_label TEXT,               -- "iPhone · Safari", parsed from the user agent
  expires_at INTEGER,
  last_seen_at INTEGER,
  last_ip_prefix TEXT,
  staff_id TEXT REFERENCES scan_staff (id) ON DELETE SET NULL,
  staff_since INTEGER,
  staff_seen_at INTEGER,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revoked_at INTEGER,
  CHECK ((token_hash IS NULL) = (token_prefix IS NULL)),
  CHECK (kind <> 'terminal' OR csrf_secret IS NULL),
  CHECK (kind <> 'terminal' OR device_role = 'scan'),
  CHECK (kind <> 'display' OR device_role <> 'scan')
);
CREATE UNIQUE INDEX scanners_org_name ON scanners (org_id, mode, name COLLATE NOCASE) WHERE revoked_at IS NULL;
CREATE INDEX scanners_org ON scanners (org_id, mode, id DESC);
CREATE INDEX scanners_event ON scanners (event_id) WHERE event_id IS NOT NULL;
CREATE INDEX scanners_staff ON scanners (staff_id) WHERE staff_id IS NOT NULL;
CREATE INDEX scanners_created_by ON scanners (created_by);
CREATE INDEX scanners_pair_created_by ON scanners (pair_created_by);

CREATE TABLE scanner_templates (
  scanner_id TEXT NOT NULL REFERENCES scanners (id) ON DELETE CASCADE,
  template_id TEXT NOT NULL REFERENCES templates (id) ON DELETE CASCADE,
  PRIMARY KEY (scanner_id, template_id)
);
CREATE INDEX scanner_templates_template ON scanner_templates (template_id);

-- One row per scan request: the record, the idempotency key and the undo link. Holds no holder data.
-- scanner_id, event_id and staff_id are not foreign keys: proof outlives configuration.
CREATE TABLE scans (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  pass_id TEXT REFERENCES passes (id) ON DELETE SET NULL,
  template_id TEXT,
  scanner_id TEXT,
  event_id TEXT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('scanner', 'user')),
  actor_id TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  staff_id TEXT,
  approved_by TEXT,                -- scan_staff id of the approving Manager
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('camera', 'wedge', 'nfc', 'manual')),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done', 'failed')),
  outcome TEXT CHECK (outcome IN ('ok', 'heads_up', 'refused')),
  reason TEXT,
  action_id TEXT,
  action_kind TEXT CHECK (action_kind IN ('check_in', 'add', 'take', 'set', 'use_up', 'undo')),
  direction TEXT CHECK (direction IS NULL OR direction IN ('in', 'out')),
  amount REAL,
  before_value TEXT CHECK (before_value IS NULL OR json_valid(before_value)),
  after_value TEXT CHECK (after_value IS NULL OR json_valid(after_value)),
  override_of TEXT,
  group_id TEXT,
  offline INTEGER NOT NULL DEFAULT 0,
  pass_version INTEGER,
  notified INTEGER NOT NULL DEFAULT 0,
  undoes TEXT,
  undone_by TEXT,
  undone_at INTEGER,
  client_ts INTEGER,
  at INTEGER NOT NULL
);
CREATE UNIQUE INDEX scans_idem ON scans (actor_key, idempotency_key);
CREATE INDEX scans_pass ON scans (pass_id, at DESC);
CREATE INDEX scans_org ON scans (org_id, mode, at DESC);
CREATE INDEX scans_scanner ON scans (scanner_id, at DESC);
CREATE INDEX scans_actor ON scans (actor_key, at DESC, outcome);
CREATE INDEX scans_event ON scans (event_id, at DESC) WHERE event_id IS NOT NULL;
CREATE INDEX scans_staff ON scans (staff_id, at DESC) WHERE staff_id IS NOT NULL;
CREATE INDEX scans_mode_at ON scans (mode, at);
CREATE INDEX scans_pending ON scans (at) WHERE state = 'pending';
CREATE INDEX scans_undoes ON scans (undoes) WHERE undoes IS NOT NULL;
-- Display history (4.6): visits, last visit and the value ledger. Undone rows are filtered as a residual.
CREATE INDEX scans_pass_ok ON scans (pass_id, action_kind, at DESC) WHERE outcome = 'ok';

-- The gate: one row per pass, action and scope ('' | 'event:<id>' | 'day:<yyyy-mm-dd>').
-- An UPSERT with a WHERE on the update is the atomic first-scan-wins, cooldown and in/out check.
CREATE TABLE scan_gates (
  pass_id TEXT NOT NULL REFERENCES passes (id) ON DELETE CASCADE,
  action_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  org_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  template_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('in', 'out', 'used', 'undone')),
  count INTEGER NOT NULL DEFAULT 0,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  last_scan_id TEXT NOT NULL,
  prev_state TEXT,
  prev_last_at INTEGER,
  prev_scan_id TEXT,
  PRIMARY KEY (pass_id, action_id, scope)
) WITHOUT ROWID;
CREATE INDEX scan_gates_count ON scan_gates (org_id, mode, scope, kind, state, template_id);

-- Apple VAS reader keys: the public half only. The browser makes the pair; the admin keeps the private key.
CREATE TABLE vas_keys (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES signing_identities (id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,        -- base64 SPKI, P-256
  key_id TEXT NOT NULL,            -- 4 bytes hex, what the reader sees
  state TEXT NOT NULL CHECK (state IN ('active', 'retiring', 'retired')),
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  activated_at INTEGER NOT NULL,
  retired_at INTEGER
);
CREATE UNIQUE INDEX vas_keys_active ON vas_keys (identity_id, org_id) WHERE state = 'active';
CREATE INDEX vas_keys_org ON vas_keys (org_id, identity_id, state);
CREATE INDEX vas_keys_created_by ON vas_keys (created_by);

-- Desk lookup by member, card or ticket number: SHA-256 of normalizeLookup(value of manifest.scan.lookup.input).
ALTER TABLE passes ADD COLUMN lookup_hash TEXT;
CREATE INDEX passes_lookup_hash ON passes (org_id, lookup_hash) WHERE lookup_hash IS NOT NULL;
-- Name search within one org and mode (the 0003 NOCASE indexes span every tenant).
CREATE INDEX passes_org_title ON passes (org_id, mode, display_title COLLATE NOCASE);
CREATE INDEX passes_org_subtitle ON passes (org_id, mode, display_subtitle COLLATE NOCASE);

-- audit_log: add 'scanner'. Safe rebuild: no table references it.
CREATE TABLE audit_log_next (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  org_id TEXT,
  actor_type TEXT NOT NULL
    CHECK (actor_type IN ('user', 'api_key', 'system', 'connection', 'device', 'scanner')),
  actor_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  request_id TEXT,
  ip_prefix TEXT,
  detail TEXT CHECK (detail IS NULL OR json_valid(detail))
);
INSERT INTO audit_log_next (id, at, org_id, actor_type, actor_id, action, target_type, target_id, request_id, ip_prefix, detail)
  SELECT id, at, org_id, actor_type, actor_id, action, target_type, target_id, request_id, ip_prefix, detail FROM audit_log;
DROP TABLE audit_log;
ALTER TABLE audit_log_next RENAME TO audit_log;
CREATE INDEX audit_org ON audit_log (org_id, at DESC);
CREATE INDEX audit_target ON audit_log (target_type, target_id, at DESC);
CREATE INDEX audit_at ON audit_log (at);
CREATE INDEX audit_actor ON audit_log (actor_id, id DESC);
CREATE INDEX audit_action ON audit_log (action COLLATE NOCASE, id DESC);
```

Rules for the file:
- Until 0014 merges, no other stream adds a column to `audit_log` (the explicit column list would drop it). The
  integration agent checks this at merge.
- `modules/audit/types.ts` `AuditActorType` gains `scanner` (g).
- `test/query-plans.test.ts` covers every list, count and search query in sections 7-9 and 11, and the history
  statements of 4.6.
- No table stores rendered displays, visits or a balance ledger: history is computed from `scans` (D24), and `scans`
  rows stay free of holder data.

### 6.1a `migrations/0018_templates_build_key.sql`

The templates module's half of display-only versions (D25). `0017` is reserved for n5.

```sql
ALTER TABLE template_versions ADD COLUMN build_key TEXT;   -- set on insert by persist.ts; old rows stay NULL
CREATE INDEX template_versions_build ON template_versions (template_id, build_key);
```

No backfill: the immutability trigger forbids it, and `NULL` keeps today's "every manifest change is stale".

### 6.2 What each query uses

| Query | Index |
| --- | --- |
| Resolve by scan code | `passes_scan_code` (unique) + `org_id` predicate |
| Resolve by barcode, lookup number | `passes_barcode_hash`, `passes_lookup_hash` |
| Typed external id, serial (manual only) | `passes_external` (org_id, external_id), `passes_serial` + org predicate |
| Name search | `passes_org_title`, `passes_org_subtitle`, ranges merged by `id IN (… UNION …)` |
| Email search | `passes_holder_email` + org predicate |
| Today N | `scans_actor` |
| Event arrived / inside | `scan_gates_count` (scope `event:<id>`) |
| Event expected | `passes_org_mode` + template list + match, cached in `scan_events.expected` for 60 s |
| Last 3 scans, asset guard, portal lastScan, `noScanDays` target | `scans_pass` |
| Scans log by org / scanner / staff / event | `scans_org`, `scans_scanner`, `scans_staff`, `scans_event` |
| Reconcile | `scans_pending` |
| Retention, test purge | `scans_mode_at` |
| Broadcast "checked in at event" | `scan_gates` PK prefix (pass_id) |
| Display history: last visit, visit counts, value ledger, month sums | `scans_pass_ok` |
| Stale passes (display-only versions) | `template_versions_build` joined to `passes.template_version` |

### 6.3 Retention and cron (`scan/jobs.ts`, registered in `jobs/cron.ts`)

| Hook | Cron | Work | Bound |
| --- | --- | --- | --- |
| `scan.reconcile` | minute | pending scans older than 60 s (section 9.3) | 100 rows |
| `scan.backfill` | minute | passes with `scan_code IS NULL`, `barcode_hash IS NULL` (not removed), or `lookup_hash IS NULL` on a template with `scan.lookup`: compute and write via `passes/repo-write.ts` `backfillScanKeys`. Stops when a run finds none (system setting `scan.backfillDone`) | 200 passes |
| `scan.retention` | daily | `scans` older than `retention.scansDays`; test `scans` older than `sandbox.purgeDays`; expired pairing codes nulled; device scanners past `expires_at` or 30 d idle are left as they are (the token still matches, so the device hears `SCANNER_EXPIRED`; the console shows them as needing a new code); `vas_keys` retired rows kept | `deleteInBatches`, inside `CRON_QUERY_BUDGET` |

Test passes purged by n6 cascade their `scan_gates`; their `scans` rows keep `pass_id NULL` until the test purge.

---

## 7. State machines

### 7.1 Scanner

```
            create                 pair (code consumed)            revoke
 (none) ──────────▶ not_paired ──────────────────────▶ paired ──────────▶ revoked
                      ▲   │ pairing code (10 min)        │  ▲                 │
                      │   └──── expires ──┘              │  └── pair again ───┘ (new token)
                      └──── unpair / idle 30 d / 180 d ──┘
 mode: test ⇄ live (Go live / Move to Test mode), audited; a test event is detached first
 staff binding (device): none ──PIN──▶ bound ──15 min idle │ 12 h │ switch │ revoke │ disable──▶ none
```

### 7.2 Scan row

```
 claim (INSERT … ON CONFLICT DO NOTHING) ─▶ pending ──finalize──▶ done (ok | heads_up | refused)
                                              │  └──effect error──▶ failed ──same key retried──▶ pending
                                              └── age ≥ 60 s ──reconcile──▶ done | failed
 needs_approval and ready write no row.  Undo writes a new row (action_kind 'undo', undoes = target).
```

Replays by key: `done` → the stored outcome rebuilt with the current card, `replay: true`; `failed` → run again;
`pending` < 15 s → 409 `SCAN_IN_PROGRESS`; ≥ 15 s → reconcile then answer. A different body under the same key →
422 `IDEMPOTENCY_KEY_REUSED`. The `request_hash` covers the pass id (or the barcode hash of the code, never the code in
clear), action, amount, value, direction, override, confirmed, group, approval staff id and scope.

### 7.3 Gate (`scan_gates`)

```sql
INSERT INTO scan_gates (pass_id, action_id, scope, org_id, mode, template_id, kind, state, count, first_at, last_at, last_scan_id)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
ON CONFLICT (pass_id, action_id, scope) DO UPDATE SET
  prev_state = state, prev_last_at = last_at, prev_scan_id = last_scan_id,
  state = excluded.state, count = count + 1, last_at = excluded.last_at, last_scan_id = excluded.last_scan_id
WHERE <allowed>
RETURNING last_scan_id;
```

A row back with this scan's id means it won. None means the gate is held; the loser reads the winner's `scans` row
for `previous` (still `pending`: `in_progress`).

| Rule | Scope | `<allowed>` | New state |
| --- | --- | --- | --- |
| `once` | `event:<id>` under an event, else `''` | `state = 'undone'`, or `state = 'out'` with direction `in` and re-entry | `in` (check_in), `used` (use_up) |
| `daily` | `day:<date>` in the event's, else the scanner's, time zone | same as `once` | same |
| `cooldown` | `''` | `last_at <= :now - cooldownMs` | `used` |
| `always` | `''` | `1` | `used` |
| direction `out` | the check-in's scope | `UPDATE … SET state = 'out' … WHERE state = 'in'` | `out` |
| override | as the action | `1`; the scan records `override_of` | as the action |

```
          check_in (in)              check_out (out)
 (none) ───────────────▶ in ◀──────────────────────▶ out      (re-entry only)
   ▲                     │ undo                       │ undo (back to in)
   └──────── undone ◀────┘
 use_up: (none) ─▶ used ─undo─▶ undone            add / take / set: (none) ─▶ used (cooldown clock)
```

Release after a failed effect: restore `prev_*` when `last_scan_id` is still this scan, or delete the row this scan
inserted (`prev_state IS NULL`).

**Check-in fast path.** A check-in that publishes nothing commits in one batch after the claim:
`[gate UPSERT, finalize scan WHERE EXISTS (gate.last_scan_id = :scanId), ledger INSERT … SELECT … WHERE EXISTS (same)]`.
A loser's batch changes nothing; one read builds its heads-up.

### 7.4 Value actions: the `commit` hook

`PublishOptions.commit?: (w: { objectKey: string; version: number }) => D1PreparedStatement[]` (workstream d).
`casPublish` becomes `db.batch([casUpdate, ...commit(w)])`. Every hooked statement guards itself with
`EXISTS (SELECT 1 FROM passes WHERE id = ? AND object_key = ?)`; `object_key` carries a random suffix per attempt, so a
lost CAS changes nothing else. Scan row and pass version commit together or not at all.

| Kind | Effect (`effects.ts`, pure, re-run on each CAS attempt) | Publishes |
| --- | --- | --- |
| `check_in` | gate only; with a `record` input: number +1, date-time = now | only with a record input |
| `add` | `min(n + amount, schema.maximum)` | yes |
| `take` | `n < amount` → `no_balance`; else `n - amount` | yes |
| `set` | value validated by the input schema; `expectedVersion` → 412 → heads-up `stale` with a fresh card | yes, unless equal |
| `use_up` | `status: 'voided'` | yes |

All publish with `source: 'scan'`, `cause: 'api'` (scanner) or `'admin'` (admin session), the `scanner` or `user`
actor, `notify: action.notify ? undefined : false`. A connection-bound pass with `allowOnConnected` gets
`fieldSources[input] = 'manual'`.

Two exits the hook never sees (AS §6.2 step 9):
- **No change** (`changed: false`: a `set` to the same value, an `add` already at the schema maximum): `publishPass`
  takes its metadata path, so `commit` doesn't run. `act` finalizes `ok` in its own batch with `pass_version` = the
  current version.
- **Effect refusal** (`take` short of balance): `effects.ts` throws `ScanEffectStop('no_balance')` from `mutate`;
  `act` releases the gate and finalizes refused `no_balance`. Any other error: release, `failed`, rethrow.

Capacity is a soft limit: doors racing the last places can overshoot by the requests in flight (at most one per
door). The dashboard shows the true count.

**Undo** (`POST /scan/scans/{id}/undo`, console `POST /scans/{id}/undo`): a new scan row, `scan.undone` in the ledger,
always silent.

| Target | Undo |
| --- | --- |
| check_in | gate to `undone` if it still points at the target, else 409 `UNDO_SUPERSEDED`; a record input −1 |
| check_out | gate back to `in` if it still points at the target |
| add | `input -= amount` floored at the schema minimum; gate `last_at` back to `prev_last_at` |
| take | `input += amount` |
| set | publish `before` if the value still equals `after`, else `UNDO_SUPERSEDED` |
| use_up | unvoid if voided, not removed, and no later void or unvoid; gate to `undone` |

### 7.5 Client loop

AC §3 is the machine: one pure reducer `reduce(state, event, { now, id }) → { state, cmds }` for both postures,
loop states `ready → checking → (member → reviewing →) applying → verdict → ready`, plus `paused`, `block`, overlays,
`unsure`, `armed`, `ignore`. Amendments:

| Change | Detail |
| --- | --- |
| Timing | `BEAT_DELAY 150`, `BEAT_MAX 550` (BM M2); the rest of `SCAN_TIMING` as AC §3.4 |
| Staff | `block` gains `'staff'` (the **Who's scanning?** sheet on `STAFF_REQUIRED` or session `staff_required`) |
| Approval | a `needs_approval` verdict offers **Manager PIN** when `approvals`, else **Ask an admin**; the PIN sheet re-sends the same draft under a **new** key with `approval` |
| Overrides | **Let in again** re-sends with a new key and `overrideOf = <heads-up scanId>` (AC §3.4) |
| `stale` | the band shows the fresh card's value; the picker reopens |
| Reasons | the client maps section 4.2's list; an unknown reason renders as a generic refusal |
| Window panels | session `not_open` / `closed` show a capsule chip and a Start-panel line; scanning still works |
| Camera during results (B) | `verdict` is no longer decode-paused. The decoder pauses only from D0 to T0 (the frozen frame while `checking`) and resumes at T0. A **different** code is accepted from T0 + 350 (`NEXT_SCAN_AFTER_VERDICT` 600 → 350); the same-code ignore windows (5 s after ok, 30 s after a refusal) are unchanged |
| Card layer (B) | new, below |
| Desk panel (B) | `member`, `reviewing`, `applying` and `approval` render as a panel (`card.kind: 'panel'`) over the dimmed camera; no tint |
| Buddy | `seat` leaves the machine (one dock seat); `view.buddy` carries `pose`, `mood`, `beat`, `key` and `card: 'in' \| 'out'` |
| System verdicts | get a card (a slate stacked band) instead of a footer strip; **Done** sits in the dock |

| Kind | Tint and ring | Door hold | Desk (`choose`) | Focus |
| --- | --- | --- | --- | --- |
| `ok` | green | 1.2 s, then the card tucks; a different code from T0 + 350 | tint and ring for 1.2 s, then they fade and the card stays up untinted until **Done**, a tap on the camera, the next scan or the 60 s idle clear; the dock keeps **Undo** and a promoted action | none |
| `heads_up` | amber | until **Done**, a tap or a different code | until **Done** | **Done** (dock) |
| `refused` | red | 3 s (`ambiguous`: until a tap) | until **Done** or the next scan | none |
| system (client) | slate | until a tap or any scan | same | first action (dock) |
| `ready` | none: the camera dims (keeps decoding) | — | the desk panel | panel heading |

**Card layer.** Beside the loop state the machine keeps `card: { phase: 'rising' | 'up' | 'tucking', id, kind:
'result' | 'panel' } | null`. Durations live in `SCAN_TIMING` (BF Motion):

| Constant | Value | Meaning |
| --- | --- | --- |
| `NEXT_SCAN_AFTER_VERDICT` | 350 | a different code is accepted |
| `CARD_RISE` | 380 | `rising` → `up` (rise 210, overshoot and settle to 380) |
| `CARD_TUCK` | 180 | `tucking` → removed |
| `CARD_SWAP_TUCK` | 150 | the old card's tuck during an interrupt |
| `DESK_DIM` | 200 | camera dim in and out |
| `COMMIT_ARM` | 260 | the dock's commit verb arms (opacity .4 until then) |
| `BEAT_DELAY`, `BEAT_MAX` | 150, 550 | unchanged (BM M2) |

- A verdict enters `rising` and emits `card.rise`; hold expiry, **Done** or a tap emits `card.tuck`.
- A different read while a result card is `rising` or `up` enters `checking` with the old card still up: the live
  pill shows **Checking…**, the buddy keeps its pose (no rummage). The next verdict emits `card.swap` (the old card
  tucks in 150 behind, the new one rises in its colour in the same frame). A verdict arriving mid-rise tucks from where
  the card is (`commitStyles()`); no snap.
- A read while a desk panel holds a draft enters `held` (UK 6.27: the strip **Another pass was scanned.** ·
  **Switch** · **Keep editing**, with the heads-up chirp). With no draft it is an interrupt.
- `applying` keeps the panel up with the busy verb in the dock; the applied outcome tucks the panel and raises the
  `ok` card.
- The reducer only emits `card.rise | card.tuck | card.swap`; the view runs FLIP from the violet pass's live box.
  Timers stay in `useScanMachine` (BM M3).
- Reduced motion: the card cross-fades in place over 120 ms; the tint switches at once.

**Desk action area** (system, never the display). While a desk panel is up:
- The card holds the header (tile, holder line or the review question), the first visible template panel only while
  an amount control is open (its `progress` or `money` row previews the draft), then the system input: stepper and
  presets, the review face (before → after, consequence), or the Manager PIN face. On a phone the amount **keypad** sits
  in a dock tray (the dock grows; the buddy peeks over it), because a Balance panel and a keypad don't fit under the
  443 px card limit together; on iPad it sits beside the panel.
- The commit pair is in the dock: secondary **Cancel** or **Back**, primary the verb, armed at T0 + 260.
- **Promoted action:** after an `ok` (or on a desk card) whose card has an available `take` action with a
  `rewardLabel` whose amount the input now covers, `present()` makes that action the dock's primary (**Redeem
  reward**). Derived from `card.actions` and `card.values`; no contract field. The card only shows the caption
  ("1 reward ready").

---

## 8. Input pipeline

### 8.1 Sources to one bus (client)

```
camera (zxing worker | BarcodeDetector) ─┐
wedge (keydown, event.code, timing)      ├─▶ bus.emit(RawRead) ─▶ normalize ─▶ store.dispatch({ type: 'read' })
NFC reader as wedge (method 'nfc')       │        (id: UUIDv7, at, sig)        │
typed code / picked row (lookup panel)  ─┘                                     ├─ local refusal (no request)
native bridge (interface only)                                                 └─ resolve | actions (API)
```

- **Camera:** decoding in a module Worker at ≤ 8 frames/s (4/s idle on a stand), centre ROI, every 4th frame wide,
  backpressure (never two frames in flight). 2D codes accept one read; 1D codes need two identical reads within
  600 ms. A hit freezes the frame. Formats come from the session (default QR, PDF417, Aztec, Code 128). AC §2.3.
- **Wedge:** one capture-phase `keydown` listener; characters from `event.code` mapped to US layout; a burst is ≥ 4
  chars, mean gap ≤ 50 ms, terminated by Enter/Tab or 150 ms idle (`WEDGE_SLOW` for batching Bluetooth readers). Bursts
  never press a focused button; a burst into a registered field restores the field and becomes a scan. Method `nfc`
  when the scanner's `reader` is `nfc` and the value has the scan-code shape. AC §2.4.
- **Manual:** one field "Name, email or code". Enter on a ≥ 4-char code with no space or `@` → `manual` code; ≥ 3
  letters → debounced search; `@` → exact email on Enter. A picked row emits `{ passId, method: 'manual' }`.
- **Native bridge:** `window.passbookNative.nfc` (a future `readVAS` shell) feeds the same bus. Not built.

### 8.2 Client normalisation (keeps data on the device)

Strip controls and trailing CR/LF/Tab, trim; empty or > 1024 bytes → local `not_found`. A URL on our origin:
`/p/…` or `/b/…` → local `add_link` (the holder showed Add to Wallet); `/scan#pair=…` while paired, or any other path
→ local `not_found`. **Never sent.** Everything else goes to the server as read.

### 8.3 Server resolution (`resolve.ts`)

1. Normalise again: strip controls, trim; derive, never store or log:
   - `codeKey`: upper-cased, spaces and dashes removed, if it matches `^[A-Z2-7]{26}$`;
   - `barcodeHash`: SHA-256 of the trimmed UTF-8 string (`barcodeHashOf`, `passes/scan-code.ts`);
   - `lookupHash`: SHA-256 of `normalizeLookup(s)` (NFKC, trim, upper-case, drop space `-` `.` `/`).
2. Candidates, in order, stopping at the first stage with rows, always `org_id = ? AND deleted_at IS NULL`:
   scan code → barcode hash (`LIMIT 5`) → lookup hash (`LIMIT 5`) → `manual` only: external id, serial → `passId`.
3. Narrow and check in the order of 2.6.
4. Build the `ScanCard` (section 4.2): pass view stripped, assets via `/api/v1/scan/passes/{id}/assets/`, last 3
   scans, values, flags, actions with availability from `scanPolicy`, and `display` for screen `ready` (4.6; its
   `needs` statements ride in the card-read batch).

### 8.4 Act (`act.ts`)

```
1  guard (2.5)
2  requestHash; claim INSERT scans … 'pending' ON CONFLICT (actor_key, idempotency_key) DO NOTHING → replay rules (7.2)
3  resolve (8.3). refused/heads-up → finalize and stop. ready (choose, confirm, asked amount, set without value)
   → delete the pending row, return the card
4  scanPolicy: role, max, approval (verify PIN), managed_elsewhere, daily cap, capacity
5  gate (7.3) → lost: finalize heads-up with previous
6  effect: check-in fast path (7.3) | publishPass with commit hook (7.4) | group: each member pass in turn
7  ledger (recordPassEvents) + writeEvent('scan.result'), both never throw
8  respond: outcome, card (fresh for value actions), counts, milestone, and display for the outcome's screen with
   post-effect values (history statements in the counts batch; a render error falls back, never fails the scan)
```

### 8.5 Ledger

| Scan | `pass_events.kind` |
| --- | --- |
| check_in ok (incl. overrides) | `scan.checked_in` |
| direction out ok | `scan.checked_out` |
| use_up or take ok | `scan.redeemed` |
| add or set ok | `scan.adjusted` |
| heads-up, pass known | `scan.heads_up` |
| refused, pass known | `scan.rejected` |
| undo | `scan.undone` |
| not found | none (the `scans` row counts it) |

`mode` = the pass's; actor `scanner` or `user`; `data = { scanId, actionId, actionKind, outcome, reason, method,
direction, amount, before, after, version, eventId, scannerId, scannerName, staffId, staffName, approvedBy, override,
offline, notified }`. Values only the pass already shows; never a holder name, email or code. Staff names are org
people, not holders. The Sync log (n1/i) adds a **Scans** filter (`?log=scans`), titles for the three new kinds, warning
tone for `scan.heads_up`.

---

## 9. Offline sync and idempotency

### 9.1 Keys everywhere (v1)

- Every `resolve`, `actions`, `undo` and batch item carries a client UUIDv7 `idempotencyKey`, `clientTs` and `method`.
  Keys are unique per `actor_key` (`scans_idem`).
- **Offline before sending:** a read gives slate `network` with no request; search and card actions show **Waiting for
  connection**.
- **No answer after sending** (network error, 5 s timeout): an `Unsure` entry, retried with the same key and body every
  10 s while online, on `online`, on `visible`, for 2 min. A re-scan of the same code inside that window reuses the key,
  so the guest gets the original answer, not "Already in". Expired entries read **Still not confirmed** and lock that
  card's actions until reopened. Entries live in IndexedDB `passbook-scan.unsure` for the shift; they hold the body
  (the code), never holder data.
- `409 PASS_CONFLICT` (three lost CAS rounds): the gate is released and the row `failed`; the client retries once with
  the same key.
- **Never queued:** `add`, `take`, `set`, `use_up`.

### 9.2 Offline check-in (v2; scanner `offline` on, scanner accepts an event)

- **Roster** `GET /api/v1/scan/roster?cursor=`: every active or voided pass of the event's templates and match rule
  **whose barcode is the scan code**, as `{ h, status, state }`, where `h` is the first 128 bits (hex) of SHA-256 of the
  scan code. No names, titles or emails. Delta by cursor every 60 s while online; valid 24 h; ≤ 50,000 entries
  (~2 MB). Passes with other barcodes are not offline-capable and refuse offline with `not_found` and the offline sub.
- **Decide** (pure, AC §6.4): in the roster, active, not in, not queued → `queued` (green, **Saved offline**), local
  `in`; already in → amber with the local time, **Let in again** queues an override (if `letInAgain` allows); voided
  or removed → red; absent → red `not_found` with **Not on the offline list from {time}**; no or stale roster →
  slate `network`.
- **Sync** `POST /api/v1/scan/batch`: ≤ 50 items, oldest `clientTs` first, through the same `act` algorithm with
  `offline = 1`. `clientTs` more than 5 min ahead clamps to now; older than 24 h answers heads-up `ended` with `at` and
changes nothing. A late
  duplicate is recorded as heads-up `already_done` after the fact (the Ticketmaster rule). A row leaves the queue only
  on its per-item outcome. Triggers: `online`, `visible`, every 15 s while rows remain, after any success, **Sync now**.
  Backoff 2, 4 … 60 s. The pending chip turns amber after 10 min.
- **Wipe** on revoke, unpair, a different `scannerId`, or a new event: roster and queue deleted; foreign rows listed
  once with **Discard**.
- iOS has no Background Sync: the queue drains only while `/scan` is open. Said once on the console setting.
- Offline verdicts carry no display: the roster has no names or inputs, so a queued check-in shows the system card
  only (BF 06). Batch outcomes have `card: null` and `display: null`.

### 9.3 Server-side recovery

`scan.reconcile` (minute) and replays: a value action with `pass_version IS NULL` never committed (the hook makes that
certain): release the gate if it still points at the scan, mark `failed`. A check-in whose gate points at the scan
won: finalize `ok` and write the ledger row; else `failed`.

### 9.4 Service worker (v3)

`scan-sw.js`, scope `/scan`, registered only on offline scanners. Network-first navigation (3 s) falling back to the
cached `scan.html`; `/assets/*` cache-first; `/api/*` never cached; a new worker activates on the next launch. Needs
`worker-src 'self'` (already on `/scan`, section 12.2) and `run_worker_first` `!/scan-sw.js`.

---

## 10. NFC (Apple VAS) end to end

### 10.1 The pass

```json
"nfc": { "message": "<scan code, 26 ASCII>", "encryptionPublicKey": "<SPKI of the active vas_key for (identity, org)>",
         "requiresAuthentication": false }
```

- **Message = scan code.** One lookup serves QR, reader-typed NFC and typing. A wedge can't prove the input came from
  NFC, so a signed token adds length, not security. The template can't choose the message; `nfc` leaves `DATA_ROOTS`
  (`templates/package/manifest-rules.ts`), so no binding writes `/nfc/*`.
- `requiresAuthentication: true` (template) forces `sharingProhibited: true`. Poster event tickets always write the key.
- Barcodes stay on every NFC pass: phones are the default scanner.

### 10.2 Gates (all at every build, `nfc/gate.ts`)

1. Platform setting **`nfc.enabled`** (default `false`). **This is the feature flag.**
2. Signing identity `nfcEnabled` (admin statement that Apple issued an NFC certificate; `db-resolver.ts:69` applies it
   to the platform identity too).
3. An `active` `vas_keys` row for (identity, org).
4. Template `nfc.enabled`.
5. Pass not removed.

Any gate off: no `nfc` key. The service that flips a gate (setting save, identity patch, key create or retire,
template version) starts a scoped bulk reissue (`startBulkReissue`, filters identity and org) with `notify: false`.
`nfc` changes `contentHash`, so on/off is a real change, never a no-change push. The active key per (identity, org) is
cached per isolate for 60 s. **Serial rule** (`docs/security.md:17`): on an NFC-enabled identity `createPassRow`
refuses a caller-chosen serial (422 `SERIAL_NOT_ALLOWED`).

### 10.3 Reader keys

- **Per (identity, org).** The reader picks passes by pass type ID and decrypts with the key matching the 4-byte key id
  in the cryptogram [V kormax]. On the shared `pass.im.plrs.wallet`, org A's reader holds only org A's key and stays
  silent on org B's passes. A leaked reader key exposes one org; rotation reissues one org.
- **Made in the browser.** **Make reader key** (identity page, admin) runs `crypto.subtle.generateKey` (ECDH P-256,
  extractable), posts the SPKI to `POST /api/v1/nfc/keys { identityId, orgId, publicKey }`, and offers the private key
  as downloads only: `passbook-reader-<keyId>.pem`, and for VTAP `config.txt` + `private1.pem` [U: verify the VTAP
  format on the first device]. **Done** waits for **I saved the key file**. PassBook stores no private key: no KEK
  gap, no export endpoint, nothing to steal server-side.
- `key_id` = first 4 bytes, hex, of SHA-256 of the public point's X coordinate [V kormax; verify with a VTAP].
- **Rotate:** make a new key; it is active at once, the old one `retiring`; the scoped reissue runs; readers hold both
  keys until `passesLeft = 0`; then **Retire** (typed confirm to retire early).
- Lost private key: rotate. Server-side decryption (VTAP Cloud, native `readVAS`) would need the private key uploaded;
  that is a later feature with its own encrypted column.

### 10.4 A tap, end to end

```
holder's iPhone ──VAS (ECDH, single use)──▶ VTAP100 (keyboard mode, US layout, Enter)
  ──types 26 chars + Enter──▶ /scan wedge source (reader = nfc, scan-code shape) ──method 'nfc'──▶
  POST /api/v1/scan/actions { code } ──▶ org-scoped scan_code lookup ──▶ same verdicts as a camera read
```

A VTAP that can't decrypt stays silent: the client shows **Nothing read? Check the reader, or scan the barcode.**
after 8 s with the reader configured. The console's **Test a reader** dialog uses the same wedge detector
(`src/web/scan/input/wedge-detector.ts`) and `POST /api/v1/nfc/test`.

### 10.5 Apple dependency and rollout

| Step | Who | State |
| --- | --- | --- |
| Ship everything with `nfc.enabled = false`: manifest, validator, designer section (disabled with **NFC needs an approved certificate.**), gates, keys, identity card, reader test | n8 | buildable now |
| Apply to Apple (developer.apple.com/contact/passkit) as a platform, for NFC on the existing `pass.im.plrs.wallet`, naming the VTAP100; 2-8 weeks; selective (loyalty, membership, coupons, event tickets; not door access) | **owner** | not started |
| Buy one VTAP100 (GBP 139) and one Bluetooth barcode reader; run the device checks (14.6) | **owner** | not started |
| Ship the personalization fix (`docs/security.md:68`: NFC stays off until then) | owner/platform | open |
| On approval: install the NFC certificate for the platform identity (secret rotation, an owner deploy step), mark it NFC-approved, make each org's reader key, load readers, test, turn on `nfc.enabled`, enable per template | owner, then admins | after approval |

If Apple insists on a new pass type ID, it is a DB identity (n2 upload); only new passes on it get NFC. Android/Google
Smart Tap is out of scope; a dual reader keeps that door open.

---

## 11. Fit with the platform

| Module | How the scanner fits | Owner of the touch |
| --- | --- | --- |
| **Passes** | `publishPass` gains `commit`; `Actor` gains `scanner`; `actorFor` passes it through; `builder.ts` computes `lookupHash` and calls `nfcDictionary`; `casPublish`/`casMeta`/`createPassRow` write `lookup_hash`; `backfillScanKeys`; NFC serial rule in `create.ts`. Check-ins publish nothing | d |
| **Pass view** | `validityOf(passJson, now)` extracted to `shared/pass-view/validity.ts` (one expiry rule); `PassCard` gains an optional `barcode={false}`; `usePassView` moves to `src/web/pass-card/use-pass-view.ts` | b, i |
| **Templates and designer** | manifest `scan` (with `display`) and `nfc`, `scanIssues`/`nfcIssues`/`scanDisplayIssues`, persisted like n7's `messaging` (`scan` is not a `DATA_ROOT` and never reaches `pass.json`); the display has its own 16 KB cap inside the 64 KB manifest; designer sections **Scanning** and **NFC** (UA §11.2-11.3, with this file's kinds and defaults) and the **Scan screen** mode (DM §10); Inputs gets a **Scanner** visibility control (`x-scan`); **Use scan code** fixes the barcode; editing `scan` outside `display` bumps the version and stale-reissues (metadata only, no push, when `pass.json` is equal); a display-only save activates at once and moves no pass (`build_key`, D25); the template overview gets a **Scan screen** card and the versions list a "Scan screen only" badge | a2, c, n5, i |
| **Blueprints** | event ticket: barcode `{{pass.scanCode}}` (alt `{{ticketId}}`), check in, `window` from `startsAt`/`endsAt` (180/60 min), `lookup ticketId`, display: one Ticket panel (Seat `big`, Ticket, Doors, Room). Coupon: `{{pass.scanCode}}`, `use_up`, display: Offer. Generic: `{{pass.scanCode}}`, check in `daily`, `lookup memberId`, display: Membership without photo. **Balance card** (the store card): keeps `{{cardNumber}}`, on `balance` (currency from its `currency` input, the only amount it has): `take` **Charge** (staff enter the amount, up to 1,000, confirm above 100) `add` **Top up** (staff enter the amount, up to 1,000, Desk) and `set` **Set balance** (Managers only, confirm), `lookup cardNumber`, display: Balance (money as the primary value and a 3-row ledger). **Stamp card** (new, DM §2.3): `{{cardNumber}}`, `add` **Add stamp** (staff step 1-5, default 1) and `take` 10 **Redeem reward** on `stamps` (0-10, goal 10), `lookup cardNumber`, display: Loyalty (the stamp grid, **1 reward ready**). Palettes, strip images and tiles: `scratchpad/template-identity/`. Generic: `phone` gets `x-widget: tel`. Boarding pass and Henry's: unchanged (default check-in, default display: Details from the front fields). Every blueprint display validates in `npm run gen` and has a rendered snapshot per screen. Done now, before real events | a2 |
| **Ledger** | kinds and group (8.5); Sync log filter and tones | n1/i |
| **Broadcasts (n7)** | `ScanTargetSchema` on broadcast and pass-list filters (an `eventId` outside the request's org or mode is 404, so a target never counts another tenant's check-ins); `scanTargetWhere()` in `scan/repo-target.ts`, used by `passes/repo-list.ts` `passFilterSql`, which `broadcasts/repo.ts` already calls. Composer **Scans** select (UA §14). Push budget: scans silent by default (D11); the scan outcome never mentions push | n7, d |
| **Sandbox (n6)** | scanner mode fixed per row, switchable (Go live); admin scanning uses the header; live refuses test passes and the reverse; test scans purged; test scanners kept; `/scan` shows `ModePill` (**Test**) in the capsule instead of `ModeBand`, so nothing hangs over the live camera; **Show a test pass** for rehearsal | n6 files: h0 |
| **Metrics** | `EventName` `scan.result` (`outcome = '<kind>.<outcome>'`, `value = amount ?? 1`); overview **Live now** card, **Scans** and **Refused** counts, a **Scans** chart; AE for charts, D1 for every number a person acts on | foundation, g, h |
| **Bundles** | card meta "In Family pack (3)"; door `group: 'bundle'` checks in every eligible member (≤ 10), one row each (`key:passId`), shared `group_id` | n8 |
| **Connections** | `managed_elsewhere` unless `allowOnConnected`; no write-back; the `GET /api/v1/scans` feed is the bridge. Outbound webhooks for every event kind are a later platform stream | n8 |
| **Portal** | pass header meta **Checked in Nov 14, 6:02 PM** / **Last scan Nov 3** from `scans_pass`; never on `/p`; no email per scan | j (later slice) |
| **Identities (n2)** | NFC card replaces the bare switch: approve, keys per org, rotate, test a reader (UA §12, with keys per org) | n2 |
| **Audit** | `scanner` actor; labels render **Scanner: Front door**; Actor filter **Scanners** | g |
| **Settings** | four platform keys (4.5) | g |
| **API docs** | OpenAPI tags (section 5); `docs/api.md`: **Scan from a till** (terminal token, `resolve`/`actions`, keys, outcome and reasons), **Read scans** (feed, `scans:read`), limits. `docs/operations.md`: NFC runbook. `docs/security.md`: scanner tokens, pairing, PINs, miss caps, NFC keys | n8 |
| **Nav and entities** | **Scanning** item (`ScanLine`, `orgScoped`); entities `scanner` (`ScanLine`), `event` (`CalendarCheck`), `staff` (`IdCard`); entity art `scanner`, `stub`, `badge` in the lazy registry (UA §1.1); palette actions **New scanner**, **New event**, **Add staff**; rename `ENTITY.activity` label to **Entry** so "event" means one thing | h0, n1 |

---

## 12. Security and threat model

Stations and screens: 18.9. Access cards and zones: 19.9.

### 12.1 Threats

| Threat | Mitigation |
| --- | --- |
| Stolen or unattended paired phone | Revoke bites on the next request (no cache). A device alone is Door or Desk: no `set`, no amount above `max`, no cooldown override, undo only its own last 10 min. Optional `dailyAmount`. Every scan attributed and undoable; console sorts by last seen |
| Pairing code guessing | 50 bits, 10 min, single use, one live code per scanner; `RL_SCAN_PAIR` 30/min per IP + 30 failures/h per IP prefix; one error for all failures; console shows the paired device at once |
| Cross-tenant enumeration | Org filter inside every lookup statement; identical `not_found`; per-actor miss cap (30/10 min) and lookup caps (20/min, 200/h); tests compare bodies |
| Guessable barcodes (`TICKET-0001`) | Blueprints move to the 128-bit scan code; designer warns; `barcode_hash` never leaves the server; miss caps; offline roster excludes them |
| Screenshot of a barcode | Not preventable for barcodes: first scan wins (atomic gate), the second is amber with when and where. NFC with `requiresAuthentication` is the anti-screenshot path |
| Double admit at two doors | `scan_gates` UPSERT: one winner, one heads-up |
| Retries applying twice | idempotency keys per actor; commit hook ties the scan row to the pass version |
| CSRF on the scanner cookie | `SameSite=Strict`, same-origin check, `x-csrf-token` = per-device secret held in memory |
| XSS on `/scan` | Strict nonce CSP as the SPA; cookie HttpOnly; no inline scripts; `wasm-unsafe-eval` and `worker-src 'self'` only on `/scan` |
| PIN brute force on a stolen device | per person per scanner 5/5 min lockout, audited; keyed hash (no offline cracking from a DB copy); PINs work only on that org's scanners |
| Insider abuse (overrides, undo, export) | overrides recorded with staff and approver, counted on the dashboard; undo rules by role; export admin-only, rate-limited, audited |
| Holder data on staff devices | no email (masked in search only), no phone, no download token, no `authenticationToken`, `webServiceURL` or serial; assets only with a 1 h grant bound to this actor (5.1); lookups never cached (`gcTime: 0`); roster hash-only |
| A template author binding hidden data into the display | role filter on the doc and the scope before evaluation; secrets never in scope for any role; `SCAN_DISPLAY_SECRET` at save; a removed path renders empty, never the raw expression (4.6) |
| A display that looks like a verdict or carries a control | no input or pass field reaches the band, tint or ring, except the holder's name in the title, which must read as a name (1-3 words of letters, no verdict word) or the band shows the system headline; the eyebrow and glyph keep the system verdict either way; icon set and chip tones exclude verdict shapes and colours; no row type renders a button, link, URL, phone or email; refusals show only a literal note; `SCAN_DISPLAY_VERDICT_WORD` warning |
| Markup or bidi tricks in bound text | rendered strings are NFC-normalized, stripped of control and bidi-override characters and capped; the client renders text nodes only, isolated with `dir="auto"` |
| A broken display blocking the door | render errors fall back to the default display with one `SCAN_DISPLAY_RENDER` log; the verdict, ledger and counts are unaffected |
| Capability URLs scanned | `/p/` and `/b/` links refused on the device, never sent |
| Codes and names in logs | never logged or audited; lookup is a POST; `/scan` is `no-referrer`; test scans every log and audit line for `@`, `wls_` and the scan-code pattern |
| NFC reader key leak | per (identity, org): one org's exposure; rotate and reissue that org; PassBook stores no private key |
| NFC before the personalization fix | `nfc.enabled` off by default; owner action in `docs/security.md` |
| D1 single-writer exhaustion | `RL_SCAN_ORG` 3000/min; check-in fast path; AE never on the hot path |
| Test/live mix-ups | scanner mode bound server-side; live never accepts test and the reverse; the **Test** chip in the capsule on every test screen (above the tint) |
| Suspended org | every scan route 403 `ORG_INACTIVE` |
| Supply chain (decoder) | `zxing-wasm` pinned exactly (≥ 2 weeks old), wasm self-hosted same-origin, decoded in a Worker |
| Camera scope | `camera=(self)` only on `/scan`; SPA documents keep `camera=()` |

### 12.2 Headers (foundation, via integration; `public/_headers` and `security-headers.ts` stay in step)

```
/scan       CSP = the SPA policy + script-src 'wasm-unsafe-eval' + worker-src 'self'
            Permissions-Policy: camera=(self), microphone=(), geolocation=(), payment=(), usb=()
            Referrer-Policy: no-referrer
/assets/decode-worker-*   CSP: default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'
/scan.webmanifest   application/manifest+json, max-age 86400
```

**One policy per response.** Cloudflare merges every matching `_headers` rule, so `/scan` would get the `/*` CSP and
`camera=()` as well: two CSPs are both enforced (no `'wasm-unsafe-eval'`), and two Permissions-Policy values conflict.
The `/scan` block detaches them first (`! Content-Security-Policy`, `! Permissions-Policy`, `! Referrer-Policy`, the
syntax `_headers` already uses for CORP). The worker CSP is scoped to the decoder worker's file
(`/assets/decode-worker-*`, a fixed `entryFileNames` prefix), also with `! Content-Security-Policy`; a dedicated
worker enforces its script's policy, so a merged `/*` CSP would block the wasm. `security-headers.test.ts` asserts
exactly one CSP and one Permissions-Policy on `/scan` and on the worker file. Which layer serves `/scan` (assets or
`spaPage()`) is checked first in P0.5.

`security-headers.ts` exports `SCAN_PERMISSIONS_POLICY` and `scanContentSecurityPolicy()` and adds `/scan` to
`NO_REFERRER_PREFIXES`. `wrangler.jsonc` `run_worker_first` adds `!/scan.webmanifest` (v3: `!/scan-sw.js`).

### 12.3 Logging

Log `scannerId`, `staffId`, `passId`, `orgId`, `code` (the error code). Refusals at `info`; `SCAN_PUBLISH`,
`SCAN_PAIR_FLOOD` and classified D1 failures at `error`. `scan.applied` sampled like `request.done`.
`SCAN_DISPLAY_RENDER` and `SCAN_DISPLAY_INVALID` at `error` with `templateId`, `version` and the element id only.
Rendered display strings are never logged; the suite-wide log check also scans for the fixtures' rendered strings.

---

## 13. Performance and bundle budgets

### 13.1 Server

| Path | D1 round trips (asserted by a counting D1 wrapper in tests) | Target Worker wall time |
| --- | --- | --- |
| Door check-in (`actions`, auto) | claim 1, candidates 1-2, policy reads 1 (batched), fast-path batch 1, counts 1 | p95 ≤ 150 ms |
| Value action | as above + `publishPass` (R2 put + CAS batch, ≤ 3 attempts) | p95 ≤ 400 ms |
| Resolve (desk card) | candidates 1-2, card reads 1 batch | p95 ≤ 120 ms |
| Lookup | 1-2 | p95 ≤ 120 ms |

The display adds **no round trips** to any path: `fields` and history statements (≤ 4) join the existing card or
counts batch, and only when the compiled doc's `needs` lists them. Rendering is CPU only, targeted under 1 ms; a test
asserts the worst-case doc under 5 ms. Compiled docs are cached per isolate (64 entries); rendered displays never are.

- Every answer carries `counts`, so a busy scanner never polls; idle scanners poll `stats` every 15 s.
- Event `expected` is cached for 60 s in the row.
- Load: 20 gates at 40 scans/min = 800/min ≈ 13/s, about 50 writes/s; inside `RL_SCAN_ORG` and D1's single writer.
- No Durable Object for counts: D1 counts on indexed tables are exact at this volume. **Amended 2026-11-05:** one
  `ScanHub` per org and mode carries push and replay to screens (18.5). It holds no source of truth, the scan path
  never awaits it (`waitUntil` after the commit), and an org without screens never calls it.
- Live fan-out target: scan request start → Customer screen paint p95 ≤ 300 ms on venue Wi-Fi (estimate 160-220 ms;
  18.5); measured in `16-scan-stations` and on devices.

### 13.2 Client

| Chunk | Loads | Budget (gzip) |
| --- | --- | --- |
| SPA initial (unchanged entry) | every page | 232,500 B today. The scanner adds only the nav label and three entities. Measure; if over, raise in one step of ≤ 1 kB with a comment in `check-bundle.ts` (as n6 and n7 did). No scanner code enters it |
| `/scan` initial (`scan.html` + modulepreloads) | `/scan` | **150,000 B** (`SCAN_BUDGET_BYTES`, a second run of `check-bundle.ts`; forbids `routeTree`, `__passbookScan`, the SPA's markers, and two string sentinels that survive minification: `scan-display:render` (a constant the renderer uses in its own error) and `SCAN_DISPLAY_DENSITY` (a validator code); function names are minified, so they can't be markers). The B shell (capsule, tint layers, dock) is about 1 kB of CSS, offset by dropping the old flood layout. Split the `tanstack` chunk group into query and router first if needed |
| `decoder` | prefetched on the Start panel | 16 kB JS + `zxing_reader.wasm` 408 kB (immutable cache) |
| `result` (card layer and FLIP ≈ 0.4 kB, band and glyphs, identity row, notes, the display painter ≈ 3.5 kB, 40 icons ≈ 5 kB) | idle after boot | 25 kB. The renderer never ships here: the scanner only paints `ScanDisplay` |
| `pass` (the full `PassCard`, no barcode, behind the identity row's chevron) | on tap | 12 kB |
| `lookup` | idle after boot | 8 kB |
| `desk` (desk panel, action area, review) | when `flow` is `choose` | 20 kB |
| `buddy` scan layer (beats, props, XL seat, `card` prop, rise/tuck/skin/pop keyframes ≈ 0.6 kB) | after first paint, fixed-size seat | ≈ 5.6 kB shipped; tests on source sizes per BM §14.1 |
| `sound` | on Start | ≤ 1.75 kB source |
| `offline` (v2) | offline scanners | 6 kB |
| Art kit (`ui/art`, beat API, `xl-scan` tier ≈ 40 B, `card="out"` ≈ 60 B) | shared | +220-280 B on 145 B headroom: expect the one 0.25 kB raise, with a comment, at the measured size |
| Registry scenes (entity art `scanner`, `stub`, `badge`) | lazy | +1.2-1.6 kB on 12 B headroom: raise the lazy scene budget by the measured amount (≤ 2 kB) with a comment |
| Admin Scanning pages | lazy routes | no initial cost |
| Designer Scan screen mode (`designer/scan/**`, renderer, presets, validator, the `/scan` display painter) | lazy with the designer route | no initial cost; the designer chunk grows by the measured amount |

- Motion: transform and opacity only, reduced motion shows stills, no layout shift (one fixed buddy seat, chips not
  banners, `aria-hidden` buddy with `pointer-events: none`). The card is FLIP'd from the violet pass's live box.
- Tint, ring, band colour and chirp land at T0 in the frame of the answer; the card is upright and its headline
  readable by T0 + 210 (the rise is the feedback, inside the 150-300 ms window); reduced motion lands everything within
  120 ms. The beat starts 150 ms after T0.
- `backdrop-filter` only on the capsule and live pill (two small layers over video); an opaque 92 % surface under
  `prefers-reduced-transparency`. Measure on an iPhone 12 [U].
- Decode loop never queues frames; a decode over 120 ms on average shrinks the ROI.

---

## 14. Test strategy

`npm run check` gates everything: biome, sizes, knip, log codes, typecheck, all tests, both bundle budgets.

### 14.1 Worker (`vitest-pool-workers`, `makeEnv()`)

`fakeAuth` gains `fake.scanner({ scannerId, orgId, mode, transport, kind, deviceRole })` (cookie and bearer forms). It
fakes the principal only: `requireScanActor` also reads the `scanners` row, so scan tests seed one with
`makeScanner(f, { orgId, settings, templateIds, staffId, ... })` (`test/helpers/factories.ts`), the frozen helper for
scan tests, and send its `headers`.

- **Tenant isolation, every scan route:** org B's scan code, barcode, lookup number, pass id, search term, asset,
  scan id and event id through an org A scanner give `not_found`, an empty list or 404, with bodies equal to a random
  code's (snapshot). A loop over the OpenAPI document proves a scanner credential (cookie and bearer) opens no
  non-scan route. Suspended org: 403 everywhere.
- **Mode:** live scanner + test pass → `test_pass`; the reverse → `live_pass`, both with `card: null`, `display: null` and `template` carrying only the name and style; lists filter by
  mode; test purge removes test scans only; Go live keeps the token and bumps `configRev`; a scanner can't join an
  event of the other mode.
- **Overrides:** `overrideOf` naming another actor's scan, another pass, an `ok` row, a non-overridable reason or a
  row older than 10 min → 422 `SCAN_OVERRIDE_INVALID`; an asset grant minted for scanner A fails for scanner B.
- **Rights:** each Matrix B row: Door on a Desk action → `needs_approval`, no row, no idempotency entry; a valid Manager
  PIN applies once and records `approved_by`; a Desk PIN can't approve; lockout after 5 misses; `letInAgain` three
  ways; undo windows; `dailyAmount`.
- **Pairing:** unknown, expired and used codes give equal `PAIRING_INVALID` bodies; preview consumes nothing; two
  concurrent pairs, one winner; a new code voids the old; re-pair revokes the old token at completion; failure caps;
  missing binding → 503.
- **Idempotency:** same key twice → same `scanId`, `replay: true`, one ledger row, one publish; same key, other body →
  422; pending < 15 s → 409; injected crash after the gate (check-in) → reconcile finalizes once; after the R2 put and
  before the CAS (value) → `failed`, gate released, replay applies once; a CAS loser's hooked statements change nothing.
- **Concurrency** (`Promise.all` on `SELF.fetch`): 10 check-ins of one ticket from 10 scanners → one `ok`, nine
  `already_done` naming the winner; 2 `use_up` → one void; 20 `add +1 always` → +20 or `PASS_CONFLICT` with values
  consistent with the `ok` count; cooldown with a fake clock; capacity then override; undo racing a new scan →
  `UNDO_SUPERSEDED`; in/out with re-entry.
- **Resolution:** every reason in 4.2 from a fixture; precedence (removed and expired says `removed`); ambiguity and its
  narrowing; wedge CR/LF/Tab; non-ASCII barcode hashes as at publish; `normalizeLookup` (`12-34 56` = `123456`);
  the card has no `barcodes`, `nfc`, `authenticationToken`, `webServiceURL`, `serialNumber` or email.
- **Lookup:** min length, exact email, 10-row cap with `more`, masking, hourly cap, doubled misses, miss cap, audit
  without the query.
- **Push budget:** a default `add` publishes with `notified: false` and leaves the budget; `notify: true` counts; the
  fourth in 24 h is silenced and the scan still `ok`; check-in creates no `pass.updated`.
- **NFC:** each gate off omits `nfc`; all on emits the right key per (identity, org); two orgs on the platform identity
  get different keys; `requiresAuthentication` forces `sharingProhibited`; removal strips it; key id vector; SPKI
  validation; caller serial refused on an NFC identity; gate flips start a scoped reissue; no private key anywhere.
- **Validator:** one case per code in 4.1; blueprints validate; designer round-trip keeps `scan`.
- **Migrations and plans:** 0014 applies on a fresh DB and after 0013/0015/0016 with data; audit ids survive;
  `query-plans` covers section 6.2; D1 round-trip counts per path (13.1).
- **Logs and audit:** a suite-wide check that no log or audit line contains `@`, `wls_`, a 26-char scan code, a PIN
  or a rendered display string from the fixtures.
- **Display** (DM §7.3): `resolve` and `actions` return `display` for each screen; refused bodies for unknown codes
  stay byte-equal across orgs (`display: null` in the snapshot); history excludes undone scans, shows **Changed
  elsewhere** after an admin edit, counts visits per month in the actor's time zone, respects retention, names removed
  scanners and **Console**; a counting D1 wrapper proves header-only and history docs keep the round-trip counts of
  13.1; a display-only save with `activate: 'display-only'` activates, keeps `build_key`, writes no `pass_versions`,
  outbox or R2 row, and the next scan returns the new display; a pass pinned to an older version renders the active
  display; a save that also changes `pass.json` is saved, not activated; the event note is in the session and not in
  `ScanDisplay`; an injected render throw still returns the verdict with the default display and one log.

### 14.2 Unit (pure)

Reducer tables and the 2,000-sequence property test (AC §10.1), `present`, `deadlines`, `ignore`, wedge detector
timelines and the US keymap (AC §10.2), `roi`, `stability`, `pick-camera`, frame loop with a fake decoder and clock,
`decide` (v2), `beat-map` (every reason has a beat, mood and chirp), `rules.ts` precedence and `scanOf` defaults,
`effects.ts`, `normalizeLookup`, `maskEmail`. Decoder fixtures: QR, PDF417, Aztec, Code 128 of a 26-char scan code,
rotated QR, 2× PDF417, decoded by `zxing-wasm/reader` in Node. Card layer: rise, tuck, swap and `held` transitions,
a different code at T0 + 349 versus 350, a verdict mid-rise, the desk `ok` hold, the promoted action. Display (DM
§7.3): one case per `SCAN_DISPLAY_*` code; renderer per row type, caps and grapheme truncation, strict missing values,
plurals, filters across a DST change; the safety rules; role filtering; variants; panel cuts; `oneLine` at every cap
boundary; `defaultScanDisplay` snapshots for every blueprint and Henry's; a 1,000-doc property test (contract parses,
density holds, render under 5 ms).

### 14.3 Web (jsdom, `vitest-axe`)

`ScanShell` in every machine state at phone, portrait tablet and landscape container sizes, light and dark: no axe
violations, live-region text and politeness (the announcement starts with the system headline), focus targets. Every
`input` is a registered wedge field. Band on-colour and tint contrast ≥ 4.5:1 from resolved tokens. `beats.test.ts`
(≤ 700 ms from the verdict, rest pose, transform/opacity only, reduced motion, sizes, snap bound at a T0 + 350 cut), one
buddy on the dock across every state, buddy never takes a click. `copy.test.ts`: every server reason has `SCAN_COPY`.
Display painter: each row type and the panel frame at 390, 820 and 1180, light and dark, with max-length text (no
overflow, chip and note tones ≥ 4.5:1); the verdict badge whenever `header.icon` is set; the eyebrow whenever
`header.title` is set; the **fit test**: per screen, the largest composition the budget admits after its header cost
fits the card at 390 × 844 without scrolling (the measurement behind `density.ts`), and at 200 % text the body
scrolls while the band and identity row stay put. Admin pages:
list, dialogs, pairing face poll, staff PIN reveal, event dashboard **Pause updates**, designer sections and the Scan
screen mode (DM §10.6), NFC card states; `kit-lint` applies.

### 14.4 e2e (Playwright, `e2e/16-scan-*.spec.ts`)

Injected source (`window.__passbookScan.read`, dev builds only) for flow specs; a fake-camera spec
(`--use-file-for-fake-video-capture` with a y4m of a seeded scan code) runs the real worker decoder, CSP and wasm
fetch. Specs: pair from the console via `#pair=` (no code left in the URL); check in, counter 1; same code within 5 s
→ chip, no second ledger event; after 5 s → amber, **Done** focused, **Let in again** → green; voided and test pass
refused; wedge burst; lookup by name; undo; offline → slate with no request; aborted response → Not confirmed, one
ledger event after reconnect; desk stamp via keypad and review, then undo; Manager PIN approval; staff sign-in; revoked
→ block panel; a different code while a card is up swaps the card; the VIP display at the door, and the same pass on a
Door scanner without the desk-only row; a coffee stamp 7 → 9 with **Redeem reward** promoted in the dock; a display
edit saved in the designer shows on the next scan with no pass version. axe at 1180×820, 820×1180, 390×844, light and
dark; `/scan` response headers asserted.

### 14.5 Ownership guards

`tools/check-bundle.ts` second budget; `knip.json` entries for `scan.html` and `decode-worker.ts`; the size rule on
every new file.

### 14.6 Device checks (manual, before release; results in the n8 report)

iPhone (Safari and Home Screen app) and iPad on current iOS: QR and PDF417 decode times from another phone's screen,
lens pick and torch, wake lock, chirps with the silent switch, a Bluetooth barcode reader and a VTAP100 typing into
the page (document mode, then field mode), camera re-prompt on relaunch, pairing inside the Home Screen app, the key-id
mismatch across two orgs on one pass type ID; the verdict read at arm's length and at 2 m in a dark room (tint, ring,
40 px headline); `backdrop-filter` frame time over live video on an iPhone 12; 20 different codes at a 350 ms cadence
(no strobing, one card, no stacked props).

---

## 15. Leftovers on `next/integration`

| Leftover | Verdict | Change |
| --- | --- | --- |
| `passes.scan_code`, `passes_scan_code` | **Keep** | Always queried with `org_id`; backfill hook mints it for dormant rows; never logged or sent to a scanner |
| `passes.barcode_hash`, `passes_barcode_hash` | **Keep** | Backfill for pre-0010 rows; ambiguity judged after narrowing; never in a DTO; miss caps |
| `{{pass.scanCode}}` | **Keep** | Event ticket, coupon and generic blueprints switch to it; designer **Use scan code** |
| `scan.checked_in`, `scan.redeemed`, `scan.adjusted`, `scan.rejected` | **Keep** | Add `scan.checked_out`, `scan.heads_up`, `scan.undone`; `scan.rejected` means refused only; add group `scans` |
| `scanner` event actor type | **Keep** | Extend both TS `Actor` types; audit gets `scanner` via the rebuild |
| `holder` event actor type | Keep (unused) | Not used by the scanner |
| `PassSource` `scan` | **Keep** | Every scan publish uses it |
| `/scan` placeholder (`routes/scan.tsx`, `scan/scan-page.tsx`) | **Remove** | Replaced by the `scan.html` entry; drop `/scan` from `isPublicPath` |
| `/admin/scanners` placeholder, nav item | **Change** | Becomes **Scanning** at `/admin/scanning`; delete `admin/scanners/` and `routes/admin/scanners/` |
| Migration number 0014 | **Use** | `0014_scan.sql` (section 6.1) |
| NW §n8 and the AGENTS.md n8 row | **Change** | Point NW §n8 to this file; ownership row below |
| Branch `next/n8` (spike) | Ignore | Not a basis |

---

## 16. Build order and ownership

### 16.1 Phases

| Phase | Scope | Exit |
| --- | --- | --- |
| **0. Foundation PR** (integration) | `ScannerAuth`, store port, CSRF, `Actor`, `reportDenied`; `scans:read`; `RL_SCAN_*` 1010-1013; `derivedHmacKey`; `/scan` headers; vite second input, `'!/scan'` in `VITE_DEV_PATHS`; `check-bundle` second budget; event kinds and group; settings keys; `AuditActorType` | `npm run check` green, behaviour unchanged (`denyAllStores` resolves null) |
| **1. Door core** | 0014; scanners, pairing, pair here, revoke, mode; events (with the staff note); resolve; `check_in` with gates and the fast path; ledger; counts; asset route; test-mode rules; the display model, validator, renderer, presets, defaults, role filter, history and the server display (every result renders a default or a blueprint's display); `/scan` entry, session, pairing, reducer with the card layer, wedge, manual, camera and decoder, the B shell, result card and display painter, sound, the dock-seated buddy, v1 unsure; console Scanners, Events, Scans tabs; blueprints switched, with displays | a paired phone checks in a ticket and shows its Ticket panel; two doors can't double admit; e2e green |
| **2. Desk** | `add`, `take`, `set`, `use_up` with the `commit` hook; undo; lookup search; miss caps; manifest, validator, designer **Scanning**; desk panel, action area, keypad, review, ready action, promoted actions; staff, PINs, sign-in, approvals; display-only versions (`build_key`, 0018); the designer's **Scan screen** mode | a desk adds a stamp, redeems a reward, undoes; a Manager PIN approves a `set`; a display edit goes live on the next scan with no reissue |
| **3. Door depth** | re-entry, capacity, bundle check-in, live dashboard, summaries, milestones, buddy beats and the beat API, metrics and overview, feed and CSV, broadcast and list targets, Sync log, portal `lastScan`, terminals, the designer's real-pass sample (`/api/v1/scan-display/preview`) | dashboard live at 5 s; overview cards |
| **4. NFC (off)** | manifest `nfc`, `vas_keys`, gates, build injection, scoped reissue, identity NFC card, browser keys, reader test, designer **NFC**, serial rule, docs | all gates tested; flag off in every environment |
| **5. Offline** | v2 roster, decide, queue, batch; then v3 service worker | conflicts shown without interrupting the door |
| **2A. Access** (after 2) | `0020`, zones, plans, the access steps and gate, Let in anyway, Zones tab, Access designer section, pass widgets, the Access card blueprint and the `gate` beat (19) | a gym morning: 24/7, Off-peak and a guest at two doors, each refusal once, a Manager lets one in |
| **3A. Stations** (after 2) | `0019`, device roles in the console, the hub, publish, catch-up, Customer screen and Desk monitor faces, the device flip (18) | a phone flipped to a Customer screen shows a stamp within 300 ms; a monitor shows both after a dropped socket |
| Later | door list (AS §7.3), outbound webhooks (a platform stream), server-side VAS decryption, native `readVAS` shell, org membership (2.10) | — |

### 16.2 AGENTS.md ownership row (replaces n8's)

`n8 | scanner | src/worker/modules/{scan,nfc}/**, src/shared/contracts/{scan,scanners,nfc,scan-display}.ts,
src/shared/copy/scan.ts, src/shared/{scan-lookup,scan-defaults}.ts, src/passkit/template/scan-display/** (a2 reviews),
src/web/admin/templates/designer/scan/** (n5 reviews), scan.html, public/scan.webmanifest, src/web/scan/**,
src/web/admin/scanning/**, src/web/routes/admin/scanning/**, migrations/0014_scan.sql`

### 16.3 Changes outside n8 (each small; the builder says so in its report)

| File | Owner | Change |
| --- | --- | --- |
| `platform/{auth,csrf,context,denied,crypto,env,analytics,security-headers}.ts`, `public/_headers`, `wrangler.jsonc`, `vite.config.ts`, `tools/check-bundle.ts`, `knip.json`, `package.json` | foundation via integration | Phase 0 |
| `contracts/{common,events,settings,broadcasts,passes,metrics,me,identities}.ts` | foundation, g, n7, i, j, n2 | section 4.5 |
| `src/shared/email.ts` | foundation | `maskEmail` |
| `src/worker/stores.ts` | e | wire `scanners` |
| `src/worker/app.ts`, `jobs/cron.ts` | integration | mount routers; three hooks |
| `modules/passes/{publish,repo-write,service,http,builder,create,repo-list}.ts` | d | sections 7.4, 10.2, 11 |
| `modules/audit/types.ts`, `admin/audit/labels.ts` | g | `scanner` actor |
| `modules/metrics/*`, `admin/overview/*` | g, h | section 11 |
| `modules/broadcasts/*`, `admin/messages/{audience,composer-state}.tsx` | n7 | scan target |
| `src/passkit/types.ts`, `template/{manifest,scan}.ts`, `templates/starter-*` | a2 | manifest (with `display`, without `values`/`identity`), validator calls, blueprints with displays |
| `modules/templates/package/{manifest,manifest-rules}.ts` | c | persist `scan` (with `display`) and `nfc`; `nfc` out of `DATA_ROOTS`; the 16 KB display cap |
| `modules/templates/{persist,repo-stale,versions}.ts`, `contracts/templates.ts`, `migrations/0018_templates_build_key.sql` | c | `build_key`, stale by build key, `activate: 'display-only'`, `displayOnly` (4.6) |
| `admin/templates/designer/*` | n5 | **Scanning** and **NFC** sections; the Scan screen mode's hooks in `model`, `apply`, `reducer`, `targets`, `outline`, `designer`, `designer-page`, `api`, `section-inputs` (DM §10.2) |
| `admin/templates/{template-overview,versions-panel}.tsx` | i | **Scan screen** card; "Scan screen only" badge |
| `admin/identities/*` | n2 | NFC card, key and test dialogs |
| `admin/passes/detail/{sync-tab,sync-model}.ts(x)` | n1/i | Scans filter, kinds, tones |
| `shared/pass-view/{normalize,validity}.ts`, `pass-card/*` | b | `validityOf`, `barcode={false}`, `usePassView` move |
| `ui/art/{buddy,buddy-art,replay}.ts(x)`, `art.test.tsx`, entity art, `lib/{nav,entities,status,actions,gaze}.ts`, `lib/guards.ts`, `lib/chunk-reload.ts`, `ui/code-field.tsx` (from `portal/`) | h0, j | beat API, the `xl-scan` tier and `card` prop, art, nav, guard, shared code field (`/scan` has its own shell, so no `AppShell` or `ModeBand` props) |
| `portal/pass-header.tsx` | j | last scan line |
| `e2e/**`, `playwright.config.ts` | integration | scan project with camera flags |
| `docs/{api,operations,security}.md`, `docs/design/{next-wave,motion-and-expression}.md`, `AGENTS.md` | n8 + foundation | docs and the ownership row |

---

## 17. For the owner

Decided here; they need nothing unless the owner disagrees:
- no tenant console access this wave (NW scope); staff PINs instead of org accounts;
- **Let in again** defaults to anyone at the scanner, always recorded;
- connection-owned inputs refused unless the action opts in;
- check-in proof kept 13 months (`retention.scansDays` 396);
- measured bundle-budget steps (≤ 1 kB SPA initial, ≤ 2 kB lazy scenes, ≤ 0.25 kB art kit) with comments;
- blueprint files switch to the scan code now, before real events. Blueprints never issue, so this changes no pass by
  itself; whether passes already issued from the old starters (and org templates made from them) move to the scan
  code, in one reissue wave with no lock-screen message, is open with the template-identity IA
  (`scratchpad/template-identity/`, `spec.md` once it lands);
- two blueprints (owner): the Balance card (Charge, Top up, Set balance) and the new Stamp card (Add stamp, Redeem
  reward); blueprints never issue passes;
- ledger rows show the action label only, no item names (owner);
- the band's custom title is literal text plus, at most, the holder's name, up to 2 lines (owner); other bound text
  goes in the meta line, chips, panels and notes.

Genuinely the owner's:
1. **Apple NFC application.** Submit it as the platform for NFC on `pass.im.plrs.wallet`, naming the VTAP100. It only
   costs time; nothing in the build waits on it (`nfc.enabled` stays off).
2. **Hardware for the device checks.** One VTAP100 (GBP 139) and one Bluetooth barcode reader. Without them, wedge and
   NFC input ship untested on iOS.
3. **The personalization fix** before `nfc.enabled` is ever turned on (`docs/security.md`, existing owner action).
4. **Confirm B strengthened** (D26). Nothing outside the screens and buddy workstreams depends on the answer: "A at
   the door, B at the desk" would swap the door's result view and the buddy seat only.
5. **Staff names in history rows.** Rows show where, not who. Default off; say if you want a `show: 'staff'` option.

Decided here for the editor (DM §10.7): the real-pass sample ships in M3 as a scope-only endpoint (5.2); canvas inline
editing stays literal text only.

Added 2026-11-05 (stations and Access cards; defaults are set, the owner may change them):

6. **Unlocking a phone that faces customers** takes a staff PIN (any active staff member). With no staff, a 2 s hold
   unlocks it and the console flags the device **Anyone can switch it back**. Default kept; say if flipping should
   require staff.
7. **First names on customer screens.** Granted and paid results greet "Hi, Maya" (station switch **Greet by first
   name**, on by default). On a stolen pass it shows the real holder's first name to the person holding it. Default
   on; say if it should default off.
8. **Access card style:** generic, so the member photo is on the card. If Apple allows VAS NFC only on store cards,
   door taps need an **Access card · tap** variant (19.6). Ask Apple with the NFC application.
9. **Not yet valid is red on access cards** (amber on tickets); a Manager can still let them in.
10. **Visits merge within 2 hours** by default (main door then pool is one visit).
11. **Guests are text-sponsored** ("Guest of Maya Okafor") this wave; linking guests to members and a guests-per-member
    cap come later. No holiday calendar this wave.

---

## 18. Stations, screens and realtime

Owner: "a multi-screen system … one or more handheld scanners … a customer interface while a desk interface shows
the scans in realtime … any combination." Detail: **ST** (`addendum/stations.md`), transport research **RT**
(`addendum/cloudflare-realtime.md`); sheets `addendum/stations/sheets/stations-topology-*.png`. This section wins
where they differ (section 1, rows 11-05).

### 18.1 Devices, kinds and roles

| Kind (ceiling) | Console name | Device roles | Who changes the role |
| --- | --- | --- | --- |
| `device` | **Scanner** (paired by code or **Pair here**) | `scan`, `customer` | the console; the device itself (18.3) |
| `terminal` | **Till** (bearer token) | `scan` | nobody |
| `display` | **Customer screen** or **Desk monitor** | `customer`, `monitor` | the console only |

- One table (`scanners`): pairing, the cookie, **Pair again**, expiry, `last_seen_at`, revocation, audit and the
  console list are the same for screens. A display never accepts templates or an event (`accepts` null) and never
  binds staff.
- The kind is what the device may ever do; the role is what it does now. A phone left facing a customer is still a
  scanner underneath, so a PIN brings it back; an iPad paired as a screen can never scan.
- UI names: the console tab **Devices** (was Scanners; `?tab=scanners` redirects to `?tab=devices`); roles
  **Scanner**, **Customer screen**, **Desk monitor**, **Till**.

### 18.2 Stations and watches

- `scan_stations`: `name`, `mode` (fixed at creation), `settings` (`ScanStationSettingsSchema`: `welcome` ≤ 40,
  default **Hold up your pass**; `refusedLine` ≤ 40, default **Please see the desk**; `greet` true; `showReady`
  true; `showDraft` true), `archived_at`.
- Members: scanners (devices and tills) and Customer screens; a device is in **at most one** station, of its own mode
  (`STATION_MODE_MISMATCH` 422). A Customer screen shows every result from its station's scanners, newest wins, the
  capsule naming the scanner that scanned. Admin sessions belong to no station.
- Stations are optional. One phone at one door needs none.
- **Desk monitors** have a `watch` (`MonitorWatchSchema`, exactly one of `{ station: true }`, `{ stationIds ≤ 8 }`,
  `{ eventId }`, `{ zoneIds ≤ 8 }`, `{ org: true }`) and an audience in `screen.audience`: `door` or `desk` (default
  `desk`), never `manager`. The 8 cap comes from the hub's 10 tags per socket. A monitor may sit in a station for the
  presence list; it still receives what its watch says.
- Edge cases (ST §1.5): two scanners on one Customer screen show the newest with the scanner's name; a scanner "on two
  stations" is one station with two screens; an archived event or zone leaves a monitor **Not set up**; a mode change
  detaches the device from its station in the same batch; following itself, a terminal, a screen or a revoked device
  is `ROLE_NOT_ALLOWED`.

### 18.3 Flip on the device

- Scanner menu › **Show to customer** (hidden for terminals, admin sessions, and when `ScannerSettings.customerToggle`
  is off; default on). Sheet **Which scanner is it facing?** lists this station's scanners, then the org's other
  online scanners in this mode (`GET /scan/role/options`). `POST /scan/role { role: 'customer', followScannerId }`
  joins that scanner's station (or creates one named after it, holding both), sets `device_role`, audits
  `scanner.role_change` with `via: 'device'`, and kicks with 4409.
- Back: press and hold the capsule 1 s → **Back to scanning?** With active staff: a staff PIN (any role), `POST
  /scan/role { role: 'scan', unlock: { staffId, pin } }`, the same lockout counters as 2.7; with staff sign-in on, the
  unlocking person is signed in. With no active staff: a 2 s hold (a filling ring) and the console flags it.
- The server holds the role; a customer holding the phone can't reach the scanner.
- State: `scan ⇄ customer` (kind `device`: device or console); `customer ⇄ monitor` (kind `display`: console only);
  revoke or unpair from any state.

### 18.4 What each face may do and see

| | Scanner | Desk monitor | Customer screen |
| --- | --- | --- | --- |
| Scan routes (resolve, actions, undo, lookup, recent, stats, summary, roster, batch) | yes | 403 `SCREEN_ONLY` | 403 `SCREEN_ONLY` |
| `GET /scan/session` | yes | yes (`screen` block) | yes (`screen` block) |
| Live socket, catch-up | yes (presence; sends beats) | yes (monitor rows) | yes (customer views) |
| `GET /scan/live/snapshot` | no | yes | no |
| Asset route | actor grant (5.1) | audience grant | never |
| Verdict copy | `SCAN_COPY` | `SCAN_COPY` | `CUSTOMER_COPY`: an ok headline, or **Please see the desk** |
| Holder | full | full | first name, on ok and ready, when `greet` |
| Photo, notes, flags, staff name, other holders, counts | per role | per audience | never |
| Template content | role-filtered (4.6) | filtered for its audience | only what `display.customer` names, customer scope (DM §11) |

**`ScanCustomerView`** (`contracts/scan-live.ts`, strict): `v`, `screen: 'ready' | 'ok' | 'see_desk'`, `ref` (the
request's idempotency key), `at`, `where` (scanner name ≤ 40), `band { headline ≤ 28, sub ≤ 40 | null }`, `greet ≤ 24
| null`, `chips ≤ 2`, `panel | null`, `lines ≤ 2` (icon + text ≤ 40: **Until 9:00 PM today**, **2 of 5 visits
left**), `milestone`, `cue { kind: 'check_in' | 'access' | 'add' | 'take' | 'set' | 'use_up' | null, unit: 'count' |
'money' | null }` (what `beat-map.ts` needs to pick the beat; never parsed from copy), `test`. No pass id, scan id,
reason or image URL: the screen can't correlate holders.

**Presented passes only.** Customer bodies (`ready` and `scan`) are rendered only when the request's `input` is a
`code` (camera, wedge, NFC or a typed code). A lookup (`input.passId`) publishes to monitors only: a desk looking
someone up must never put that holder's name or balance on the counter screen. When the desk card closes without an
action, the scanner sends an `idle` beat, so a `ready` card never lingers for the next customer (the 60 s hold is
the backstop).

`CUSTOMER_COPY` (`src/shared/copy/scan-customer.ts`): idle = station `welcome`; `reading` beat **Checking…**; ok
check-in **Checked in** (event: **You're in**, sub the event); access **Access granted**, sub the zone; count add
"+2 stamps" sub "9 of 10"; money **Added $20.00** / **Paid $12.00**; reward **Enjoy your reward**; `use_up`
**Redeemed**; `set` **Updated**; milestone reward **Reward ready**; `ready` **Hi, Sam** (or **Hello**) with the
template name; `review` **To pay $12.00** · **Balance after: $30.50** (count: **Adding 2 stamps**); every heads-up,
refusal, mode mismatch and not found: the station's `refusedLine` (**Please see the desk**) with no sub, except
`outside_hours` **Your plan opens {when}.** (`when` as the staff copy, "at 4:00 PM" today or "Sat 8:00 AM", in
`access.timeZone`; no sub when nothing opens within 7 days) and `guest_expired`, `guest_visits_used` **Your guest
pass has ended.**; undone: back to idle. The server formats every customer time (the screen's clock is not
trusted). The zone, the plan's other hours and a suspension never reach a customer.

**`ScanMonitorRow`**: `ref`, `scanId | null` (a resolve-only refusal), `at`, `st`, `device { id, name }`, `staff`,
`kind` (no `ready`), `reason`, `action`, `direction`, `method`, `holder`, `template { name, style }`, `value`
(filtered), `zone`, `event`, `override`, `undone`, `display` (the outcome's display for the monitor's audience). One
builder, `toMonitorRow()`, serves the live publish and the snapshot, so the feed reads the same before and after a
reload.

Monitor photos use an **audience grant**: `g = HMAC(derivedHmacKey(env, 'scan-asset'), 'aud:' ‖ orgId ‖ ':' ‖ mode ‖
':' ‖ audience ‖ passId ‖ exp) ‖ exp`, 1 h, valid for a monitor principal of that org, mode and audience or higher.

### 18.5 Transport: `ScanHub`

- **Key** `env.SCAN_HUB.getByName(\`${orgId}:${mode}\`)`, SQLite-backed, raw Hibernation API, no framework. Live and
  test never share a hub.
- **Tags** (from the D1 row at upgrade, never the query): scanner `dev:<id>`, `aud:scan`, `st:<id>`; Customer screen
  `dev:<id>`, `aud:customer`, `st:<id>`; Desk monitor `dev:<id>`, `aud:door|desk`, then `w:org`, `w:st:<id>` (1-8),
  `w:ev:<id>` or `w:zn:<id>` (1-8). Attachment `{ dev, name, org, mode, role, aud, st, watch, exp }` < 1 KB, `exp =
  min(token expiry, now + 15 min)`. The hub checks `exp` before every send and closes an expired socket with 4401;
  the client reconnects at once with `since`/`epoch` (no **Reconnecting** chip: nothing is missed), which re-runs
  auth. So a revoked, re-roled or re-watched device stops receiving within 15 minutes even if its kick is lost.
- **Publish** `{ st, ev, zones, at, ref, audiences: { customer?, door?, desk? } }` over DO RPC in `waitUntil` after
  the D1 commit. `zones` is the scanning device's checked zones plus their ancestors (≤ 32 ids, from the guard's
  scanner read), not the deciding zone: a Pool watch sees every result at a door that checks Pool, including the
  refusals decided before the zone step (`suspended`, `voided`, `not_found`), and a watch on a site sees its child
  zones. Targets = Customer screens of `st:<st>` (customer body) ∪ `w:org` ∪ `w:st:<st>` ∪ `w:ev:<ev>` ∪ `w:zn:<z>`
  for each z in `zones` (body for the socket's audience), deduped by socket; a socket whose body is missing gets
  nothing. The
  hub assigns `seq` (monotonic) and keeps `epoch` (new when its table is new).
- **Who publishes:** `actions` (ok, heads-up, refused; never a replay) → `scan`; `resolve` → `ready` (customer body,
  only with a Customer screen in the station and `showReady`), and heads-up/refused → `scan` with `scanId: null`;
  undo → `undo`; v2 batch → `scan` to monitors only. Admin "Scan as admin" publishes to `w:org` and `w:ev` only.
- **Rendering:** the Worker renders at most three bodies per scan (`customer`, `door`, `desk`) with the display model
  and the data the request already loaded; the hub never builds content. `actor.live` (two scalar subqueries in the
  guard's scanner read: a Customer screen in the station; the monitor audiences in the org and mode) skips rendering
  and the RPC when nothing listens, so a single-phone org costs nothing. A test counts `SCAN_HUB` calls: 0.
- **Buffer:** hub table `events(seq, at, st, aud, ev, zn, body)`; staff rows 15 min or 500; customer rows 30 s,
  replayed only if under 10 s old. Hourly prune alarm while rows exist, not re-armed when empty.
- **Messages** (`LiveEventSchema`): `hello { epoch, seq, replayed, presence }`, `scan { epoch, seq, at, st, ref,
  body }`, `undo { epoch, seq, at, st, ref, scanId | null }` (`ref` is the undone scan's idempotency key; Customer
  screens get `scanId: null` and match on `ref`), `ready { at, st, ref, body }` (ephemeral), `beat { st, dev, k:
  reading | idle | review | cancel, ref?, amount?, actionId? }` (ephemeral), `presence` (ephemeral), `reset { epoch,
  seq }`. Clients send one message, `beat`, scanners only (anything else closes 1008; 10/s cap); a beat reaches only
  the sender's station's Customer screens and changes nothing stored. `ping`/`pong` are raw strings answered by
  `setWebSocketAutoResponse`, so they never wake the hub.
- **Order and dedupe:** clients keep a 200-entry `ref` set; monitors order by `at` desc then `seq`; a Customer screen
  shows an event only if its `at` ≥ the shown one's; a `scan` replaces the `ready` of the same `ref`; `review` and
  `cancel` beats apply only to the `ready` of the same `ref`.
- **Reconnect:** `?since=<seq>&epoch=<epoch>`; replay the socket's rows, then `hello`; gap too large or a new epoch:
  `reset` → monitors reload `GET /scan/live/snapshot`, Customer screens go idle. Client heartbeat: ping every 20 s while
  visible, reconnect after 8 s without pong; on `visibilitychange`, `pageshow` and `online` ping and reconnect after
  2 s; backoff 0.5 → 10 s with jitter. While unhealthy: `GET /scan/live/events?since&epoch` every 2 s for 2 min, then
  5 s; **Reconnecting** chip after 2 s, no layout shift. Screens hold a Screen Wake Lock, re-requested on every
  `visible`.
- **Close codes** (`LIVE_CLOSE`): 4401 expired (reconnect re-runs auth), 4403 revoked, unpaired or org suspended (no
  reconnect; boot gate block panel), 4408 replaced (≤ 3 sockets per device, oldest closed), 4409 reconfigure
  (refetch the session, reconnect at once).
- **Cost and latency:** ≈ $0.30-0.75 a month platform-wide at 200 orgs, 1,000 devices and 50k scans a day; idle ≈ $0.
  Budget: request → commit ≤ 130 ms, renders ≤ 5 ms, RPC 5-30 ms, fan-out 1-5 ms, socket 10-40 ms: ≈ 160-220 ms
  against the 300 ms p95 target. The `reading` beat (sent at decode) lands within 100 ms.
- **Failure:** a throwing hub never changes the scan's response (logged `scan.live.publish_failed`, code
  `LIVE_PUBLISH`); screens catch up on reconnect. Cloudflare runtime updates can drop every socket at once; jittered
  backoff, the per-device cap and `RL_SCAN` bound the burst. Our own deploys keep hibernated sockets (deferred code
  updates).

### 18.6 Routes

Device API (`/api/v1/scan`):

| Method and path | Guard | Body or query → result |
| --- | --- | --- |
| `GET /live` | `requireLivePrincipal` (scanner cookie only, no isolate cache, not revoked or expired, org active), `Upgrade: websocket` else 426 `UPGRADE_REQUIRED`, `Origin` = `PUBLIC_BASE_URL` (or the legacy origin while both serve) else 403 `LIVE_ORIGIN`, `RL_SCAN` | `?since&epoch` → 101, forwarded to the hub as a new `Request` carrying only the upgrade headers and the attachment in `x-pb-live` (a client-sent `x-pb-live` never passes; the hub isn't routable from outside and also checks `ctx.id.name` = `org:mode` of the attachment) |
| `GET /live/events` | live principal | `?since&epoch` → `LiveCatchUp` (`{ epoch, seq, events } \| { reset: true }`) |
| `GET /live/snapshot` | live principal, role `monitor` | → `ScanLiveSnapshot` (`counts { visitsToday, refusedToday, inNow \| null }`, ≤ 50 rows, presence) |
| `GET /role/options` | scanner principal, kind `device` | → `ScanFollowOptions` (≤ 50) |
| `POST /role` | scanner principal, kind `device`, CSRF, `RL_SCAN` | `ScanRoleChange` → `ScanSession` |

Bearer tokens and admin sessions get 401 `SCANNER_UNAUTHENTICATED` on the live routes. No CSRF on the socket: its only
client message changes nothing stored.

Console (`requireAdmin`, CSRF, mode from the header, org asserted): `GET`, `POST /api/v1/scan-stations`; `GET`,
`PATCH /api/v1/scan-stations/{id}` (kicks members 4409); `POST /{id}/archive` (detaches, kicks); `POST /{id}/devices`
(`{ scannerIds ≤ 50 }`); `POST /api/v1/scanners` accepts `kind: 'display'` with `deviceRole`, `stationId` or
`watch`, `screen`; `PATCH /api/v1/scanners/{id}` adds `stationId`, `watch`, `screen`; `POST
/api/v1/scanners/{id}/role` (`{ role, stationId?, watch? }`, any role the kind allows, no PIN); `GET
/api/v1/scans?stationId=`. The Devices list shows a screen as online while the hub holds its socket (one
`hub.presence()` RPC per list load and mode); scanners keep `last_seen_at` (2.7).

Errors: `SCREEN_ONLY` 403, `ROLE_NOT_ALLOWED` 422, `STATION_MODE_MISMATCH` 422, `STATION_ARCHIVED` 422,
`UNLOCK_REQUIRED` 403, `PIN_INVALID` 400, `LIVE_ORIGIN` 403, `UPGRADE_REQUIRED` 426.

Revocation and changes: revoke, unpair and expiry → `hub.kick({ dev }, 4403)`; role, station, watch, screen settings
or mode changes → 4409 for that device; station rename or archive → 4409 for `st:<id>`; org suspended →
`kickAll(4403)` from the orgs suspend hook (g). Revoke, unpair, role and watch kicks are awaited after the batch (one
retry, 2 s cap; a failure logs `LIVE_KICK` and doesn't fail the request); the rest run in `waitUntil`. A lost kick is
bounded, not harmless: the hub checks the 15-minute attachment expiry before every send, and every upgrade and
catch-up re-resolves the cookie.

### 18.7 Data: `migrations/0019_scan_stations.sql`

Additive, no rebuild; needs P0-1 (`device_role` in 0014).

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
ALTER TABLE scanners ADD COLUMN watch TEXT CHECK (watch IS NULL OR (json_valid(watch) AND device_role = 'monitor'));
-- ScreenSettingsSchema: monitors { audience, alerts, sound }; null otherwise
ALTER TABLE scanners ADD COLUMN screen TEXT CHECK (screen IS NULL OR json_valid(screen));
CREATE INDEX scanners_station ON scanners (station_id, device_role) WHERE station_id IS NOT NULL;
CREATE INDEX scanners_org_role ON scanners (org_id, mode, device_role) WHERE revoked_at IS NULL;

-- The station a scan came from, for the monitor snapshot and the Scans log filter. Not a foreign key (6.1).
ALTER TABLE scans ADD COLUMN station_id TEXT;
CREATE INDEX scans_station ON scans (station_id, at DESC) WHERE station_id IS NOT NULL;
```

Checked 2026-11-05 on SQLite 3.54: 0001-0016 from `next/n8-p0` with P0-1 applied, then 0019 and 0020, apply cleanly;
a watch on a non-monitor fails; deleting a station nulls `station_id`. The hub needs no D1 table.

Wrangler and exports (integration owns both files):

```jsonc
// wrangler.jsonc
"durable_objects": { "bindings": [{ "name": "SCAN_HUB", "class_name": "ScanHub" }] },
"exports": { "ScanHub": { "type": "durable-object", "storage": "sqlite" } }
```

`src/worker/index.ts` exports `ScanHub` from `./modules/scan/live/hub.ts`; `npm run gen` updates
`worker-configuration.d.ts`; `tools/wrangler-config.test.ts` asserts the binding and the export. The first deploy with
the class is a `wrangler deploy` by the owner, never `versions upload`.

### 18.8 Contracts

| File | Names |
| --- | --- |
| `contracts/scan-live.ts` (new; ST) | `DeviceRoleSchema` (re-export), `ScanStationSettingsSchema`, `ScanStationSchema`, `Create/UpdateScanStationSchema`, `ScanStationListQuerySchema`, `ScanStationAssignSchema`, `MonitorWatchSchema`, `ScreenSettingsSchema`, `ScanRoleChangeSchema`, `ScanFollowOptionsSchema`, `ScanCustomerViewSchema`, `ScanMonitorRowSchema`, `LivePresenceSchema`, `LiveEventSchema`, `LiveClientMessageSchema`, `LiveCatchUpSchema`, `ScanLiveSnapshotSchema`, `LIVE_CLOSE` |
| `contracts/scanners.ts` | P0: `kind` + `display`, `deviceRole`, `accepts` nullable. Later, additive: `station`, `watch`, `screen`, `CreateScannerSchema.kind` + `display` |
| `contracts/scan.ts`, `scan-session.ts` | P0: session `scanner.kind` + `display`, `scanner.deviceRole`. Later: `ScanSession.screen`, `ScanSession.live { on }`, `ScanPairPreview.role`, `.stationName`, `ScannerSettings.customerToggle` (default true) |
| `passkit/template/scan-display/schema.ts` | P0: `ScanDisplayDoc.customer` (DM §11) |
| `copy/scan-customer.ts` (new; ST) | `CUSTOMER_COPY` |

### 18.9 Security and privacy

| Threat | Mitigation |
| --- | --- |
| A customer uses a facing phone to scan or look people up | The server holds the role; every scan route answers `SCREEN_ONLY`; flipping back needs a staff PIN (or the flagged hold) |
| A customer screen leaks holder data | A separate, strict `ScanCustomerView`; allow-listed rows over a customer scope with every `x-scan` input removed; refusals carry no reason; no image URL; a recursive test scans every outcome fixture's customer body for the holder's data beyond the first name |
| The previous customer appears after a reconnect | Customer rows replay only under 10 s and expire in 30 s; idle clears the card |
| Cross-site WebSocket hijacking | `SameSite=Strict` cookie plus an `Origin` check on upgrade |
| Org or mode crossing | Hub per org and mode; tags and attachment from the D1 row; isolation tests per org, mode and station |
| A revoked screen keeps receiving | Kick 4403 awaited with a retry; upgrade and catch-up re-resolve the cookie; the hub drops a socket past its 15-minute attachment expiry before sending |
| A desk lookup shows someone else on the counter screen | Customer bodies only for a presented code (18.4); a lookup publishes to monitors only; the scanner's `idle` beat clears a `ready` card |
| A forged attachment | The route builds a new request and sets `x-pb-live` itself; the hub checks the attachment's org and mode against its own name |
| A stolen monitor | Revoke as any device; monitors never see Manager-only content, never act, and their photo grants are bound to the audience and expire in 1 h |
| Socket floods | ≤ 3 sockets per device, `RL_SCAN` on upgrade, 10 beats/s, 512-byte messages, strict client schema |
| Logs | `scan.live.*` lines carry `orgId` and `code` only; never bodies, names or tickets |

### 18.10 Files and tests

Files (ST owns unless noted; plan §3): `modules/scan/{routes-stations,routes-live,routes-role,stations,role,
repo-stations}.ts`, `modules/scan/live/{hub,hub-sql,tags,identify,audiences,rows,publish,snapshot,guard}.ts`,
`src/web/scan/live/{socket,use-live,live-store,wake}.ts`, `contracts/scan-live.ts`, `copy/scan-customer.ts`;
`passkit/template/scan-display/customer.ts` (DS); faces in `src/web/scan/{customer,monitor,role}/**` (CD, MN; layout in `addendum/ux.md`); the
console Devices tab (AD). Tests: ST §7.6 (isolation, customer safety, monitor audience, guard, roles, hub replay and
hibernation with `evictDurableObject(stub, { webSockets: 'hibernate' })`, prune with `runDurableObjectAlarm`, publish
counts, upgrade refusals, a lookup publishing no customer body, an expired attachment receiving nothing, a Pool
watch receiving a `suspended` refusal at a Pool door and a site watch receiving its child zone, undo reaching a
Customer screen by `ref`), unit (`tags`, `live-store`, `CUSTOMER_COPY`, `renderCustomerView`), web (faces in both
themes, reduced motion, **Reconnecting** without layout shift), e2e `16-scan-stations`.

---

## 19. Access cards and zones

Owner: "Access Card … access control like gym memberships, business access … unlimited access is reasonable (so there
wouldn't be an 'already scanned' screen) … 24/7 vs timed/guest access … one pass should be able to open one or more
'zones' (where a scanner would be assigned to a zone to verify access)." Detail: **AX** (`addendum/access.md`, with
the reference evaluator `addendum/access/gen/access-eval.mjs`, 29 tests passing, and the blueprint package
`addendum/access/pass/starter-access-card/`).

### 19.1 A grant

A scan of an access-template pass by a template scanner ends in:

| Result | Kind | Reason | Band | Records |
| --- | --- | --- | --- | --- |
| Granted | `ok` | null | **Access granted** · sub the zone, plus "until 4:00 PM" when access closes within 12 h | `scans` row (`zone_id`, `visit`, `access_plan`), the gate row |
| Re-entry wait (opt-in) | `heads_up` | `cooldown` | **Entered 2 min ago** · **Next entry in 8 min.** | heads-up row; **Let in again** per `letInAgain` |
| Denied | `refused` | 19.5 | reason copy | refused row |

`scanOf` resolves the access template's `check_in` to `repeat: 'always'`: five doors in a morning are five grants and
one visit. `ScanOutcome.access` and `ScanCard.access` (`ScanAccessSchema`, nullable, P0-5): `plan { id, label, kind
}`, `zone | null` (null when the scanner checks no zones), `closesAt`, `nextOpenAt`, `visits { used, limit | null } |
null`, `visit`, `timeZone` (the deciding zone's clock: the client formats `{time}` and `{when}` with it, never with the
device's or the scanner's zone). The client paints
**Access granted** when `access` is set; nothing else branches on it. On `ready` the same steps run without the gate,
so the desk sees "Opens 8:00 PM" before acting.

### 19.2 Plans (`scan.access` in the manifest)

```ts
type WeeklyHours = Partial<Record<'mon'|'tue'|'wed'|'thu'|'fri'|'sat'|'sun', string[]>>; // "HH:MM-HH:MM", 1-4/day
interface AccessGrant { zone: string | { input: string }; hours?: WeeklyHours }          // key, "*", or an input
interface AccessPlan { id: string; label: string; kind: 'always' | 'timed' | 'guest';
  hours?: WeeklyHours; zones: AccessGrant[]; visits?: number; days?: number }
interface AccessManifest {
  input: { plan: string; zones?: string; from?: string; until?: string; visits?: string; sponsor?: string };
  plans: AccessPlan[];                                         // 1-12
  suspend?: { input: string; equals: string[] };
  rules?: { visitGapMinutes?: number; reentryMinutes?: number | null };  // 120 (0-720); null (1-240)
}
```

- Plans live in the template's **active** version (like the display, D25), so a rule change applies at the next scan.
  `template_versions.build_key` includes `scan.access` only when a binding reads `{{access.…}}`, so a plan edit
  reissues faces through the stale job only for templates that show plan data.
- Per pass: the plan (an `access-plan` input), add-on zones (`access-zones`), start, end, visit limit (guests),
  sponsor (text ≤ 80, `x-scan: desk`). A guest with no end ends at local midnight after the start day + `days` − 1
  (default 1), in the org's time zone. The passes service writes that instant into the `until` input at create, and
  on an update that moves a pass onto a guest plan with no end, so the face, Wallet's `expirationDate` and the door
  agree even if the org's time zone or the plan's `days` change later. Using the Access card blueprint, or turning on
  **Use as an access card**, asks for the org's time zone when it has none (default the browser's).
- Validation: `accessIssues` (AX §2.4) at save and upload: `ACCESS_SHAPE`, `ACCESS_NO_CHECK_IN`, `ACCESS_PLAN_*`,
  `ACCESS_INPUT`, `ACCESS_HOURS_*`, `ACCESS_ZONES_EMPTY`, `ACCESS_ZONE_KEY`, `ACCESS_GUEST_RANGE`,
  `ACCESS_RULES_RANGE`, `ACCESS_PLAN_IN_USE`; warning `ACCESS_ZONE_UNKNOWN`. Pass inputs (passes service, 422):
  `ACCESS_PLAN_UNKNOWN`, `ACCESS_ZONE_UNKNOWN`, `ACCESS_WINDOW`, `ACCESS_VISITS`.

### 19.3 Zones

- `scan_zones`: `name` (1-40, unique among active zones), `key` (slug, fixed once a template uses it), `parent_id`
  (depth ≤ 4, no cycles), `time_zone` (roots only), `sort`, `archived_at`. Org data, not per mode: a test scanner opens
  the same pool.
- A pass's grants are its plan's zones plus its add-ons; `*` grants every zone. The grant that applies to a scanner
  zone is the **nearest** of that zone and its ancestors, else `*`. Hours that apply = plan hours ∩ the grant's hours;
  add-ons follow plan hours.
- `scanner_zones`: 0-8 per scanner, in order; the console label **Checks**, empty **Any zone**. A scanner grants when
  the pass opens any of its zones now; the answer names the first open zone, else the soonest to open. Event scanners
  have no zones.
- With no scanner zones (**Any zone**) the scanner grants when any of the org's active zones the pass covers is
  open, and the answer names no zone (`zone: null`, no band sub). A scanner zone id that isn't one of the org's
  active zones grants nothing (never falls through to `*`). Zones stay on a scanner moved onto an event but are
  ignored there.
- Hours are wall clock in the zone's time zone (nearest root, else `orgs.time_zone`, else the scanner's `time_zone`,
  a console setting, never the device clock), via `Intl`.
  DST: a span starting in the spring gap opens at the gap's end; the repeated autumn hour is open both times;
  overnight spans belong to their start day; ends are exclusive; `nextOpenAt` looks 7 days ahead. No holidays in v1.
- Org zones are read once per isolate for 60 s, keyed by org and `orgs.zones_rev` (bumped on every zone write).
  `zones_rev`, the scanner's zone ids and their ancestors come from scalar subqueries in the guard's scanner read
  (no extra round trip), so an archive takes effect at the next scan.

### 19.4 Evaluation order and the gate

Steps 1-9 unchanged. For an access template on a scanner without an event:

| Step | Check | Answer |
| --- | --- | --- |
| 10 | `removed`, `voided`, `expired` | refused; on a guest plan `expired` → `guest_expired` |
| 10a | suspend rule (`scan.access.suspend`) | refused `suspended` |
| 10b | start (input) > now | refused `not_yet_valid` (`at`) |
| 10c | guest: now ≥ guest end | refused `guest_expired` (`at`) |
| 10d | no scanner zone covered by a grant | refused `zone_not_included` |
| 10e | no covered zone open now | refused `outside_hours` (`nextOpenAt`) |
| 11-12 | `scan.window`, event window | skipped |
| 13 | stop flags under `auto` | heads-up `check_required` |
| 14 | action rights, connection ownership | unchanged (`check_in` is Door) |
| 15 | **access gate**: the re-entry wait, then the guest visit limit | heads-up `cooldown`; refused `guest_visits_used` |
| 16 | effect | `ok` with `access` |

10a-10e are `decide()` in `src/passkit/template/access/decide.ts` (pure; ported from `access-eval.mjs`), called from
SV's `resolve.ts` and `act.ts` through `modules/scan/access.ts`. An unknown plan id at scan answers
`zone_not_included` and logs `ACCESS_PLAN_UNKNOWN` with ids.

**Gate:** one `scan_gates` row per pass, `action_id = 'access'` (a literal, so renaming the action or adding a second
`check_in` keeps one count), `scope = 'access'`, `kind = 'check_in'`; `count` holds **visits**. One
UPSERT decides (AX §3.5): the visit counter increments only when the grant is more than the gap after `last_at`; the
`WHERE` refuses a grant inside the wait (unless an override) and a new visit past the limit (unless an override).
Won: `ok`, `visit = (prev_last_at IS NULL OR now − prev_last_at > gap)`, in the check-in fast-path batch. Lost: one
read says which: inside the wait → `cooldown`, else `guest_visits_used`. Undo works only while the gate still points
at the grant (else 409 `UNDO_SUPERSEDED`, as 7.3): the first grant ever deletes the row; otherwise `last_at =
prev_last_at`, `last_scan_id` = the undo's own scan id (one step only), `prev_*` cleared, and `count − 1` when the
grant had `visit = 1` (`undoGate` in the reference). **Reset visits** (Manager-equivalent: admin console) deletes the
row, audited. Racing scans: two doors scanning a guest with one visit left at once both pass (the second rides the
visit the first opened; `count` rises once); a guest with none left is refused at both.

**Events and access:** a templates scanner applies each template's own rule (an access card grants; a ticket checks in
once). An event scanner checks every pass in once per event, access cards included; 10a-10c still run; zones, hours,
the gate and `repeat: always` don't; the outcome is **Checked in**.

### 19.5 Reasons, copy and overrides

| Reason | Kind | Headline | Sub | Manager override |
| --- | --- | --- | --- | --- |
| (granted) | ok | **Access granted** | `{zone}` · `{zone} · until {time}` | — |
| `zone_not_included` | refused | **Not in plan** | **{plan} doesn't include {zone}.** / no zone: **{plan} opens no zone here.** | yes |
| `outside_hours` | refused | **Outside hours** | **{plan} opens {when}.** / **{plan} has no hours this week.** | yes |
| `not_yet_valid` | refused (access only) | **Not open yet** | **Opens {time}.** | yes |
| `guest_expired` | refused | **Guest pass ended** | **Ended {time}.** | yes |
| `guest_visits_used` | refused | **No visits left** | **Used {limit} of {limit}.** | yes |
| `suspended` | refused | **Suspended** | **Ask them to see the front desk.** | no |
| `cooldown` | heads-up | **Entered {ago}** | **Next entry in {wait}.** | per `letInAgain` |

**Let in anyway** shows in the dock on the five overridable refusals whenever `letInAgain` isn't `never`; it always
needs a Manager (signed in, or a PIN approval), records a grant with `override_of`, and a guest override counts a
visit, so `visits.used` can pass the limit (the monitor shows it). `suspended`, `voided`, `removed`, `expired` (non
guest) and mode mismatches are never overridable.

### 19.6 The Access card blueprint

`templates/starter-access-card/` (`blueprint: true`, TI §6.3), gallery second: Membership, **Access**, Poster,
Balance, Stamp, Coupon, Event, Boarding. Generic style, **Cobalt** `rgb(29,58,186)`, labels `rgb(207,224,255)`,
icon `key`; `sharingProhibited: true`; header **Plan**, primary **Name**, secondary **Zones** and **Valid until**,
auxiliary **Member** and **Hours**; barcode QR `{{pass.scanCode}}`, alt text `{{memberId}}`; `expirationDate` =
`{{access.until}}`; the member photo is the per-pass thumbnail. Plans: **24/7** (`all_access`), **Off-peak**
(`off_peak`: Mon-Fri 6 AM-4 PM and 8-11 PM, Sat-Sun 8 AM-8 PM), **Guest day** (`guest_day`); gap 120, no wait. Its
`scan.display`: photo (`minRole: door`), plan chips `c_plan`/`c_timed`/`c_guest` (icons `infinity`, `clock`,
`ticket`), a Visits panel (members: this month, last visit; guests: visits left, until; **Guest of** for Desk), refused
note **Ask at the front desk.**, customer block `{ chips: [c_plan, c_timed, c_guest], panel: null }`. `access.*`
reaches the build through `PassScope.access` (`accessScope()` in `passes/builder.ts`); a zone rename reissues the
org's access passes that show it. Henry's gym templates can adopt access later with one version each and no reissue
(AX §4.8).

### 19.7 Data: `migrations/0020_scan_access.sql`

Additive, independent of 0019. Touches `orgs` (g's table: two added columns; reported to g).

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

-- The deciding zone, whether the grant started a visit, and the plan then. Not foreign keys (6.1: proof outlives config).
ALTER TABLE scans ADD COLUMN zone_id TEXT;
ALTER TABLE scans ADD COLUMN visit INTEGER CHECK (visit IS NULL OR visit IN (0, 1));
ALTER TABLE scans ADD COLUMN access_plan TEXT;
CREATE INDEX scans_zone ON scans (zone_id, at DESC) WHERE zone_id IS NOT NULL;
```

Depth, cycles and cross-org parents or scanner zones are service rules (`ZONE_DEPTH`, `ZONE_CYCLE`,
`ZONE_ORG_MISMATCH` as a 404 body). `scan_gates` needs no change. Retention: nothing new.

### 19.8 Contracts and routes

| File | Names |
| --- | --- |
| `contracts/access.ts` (new; AX) | `ZoneKeySchema`, `WeeklyHoursSchema`, `ScanZoneSchema`, `Create/UpdateScanZoneSchema`, `ScanZoneListQuerySchema`, `ScannerZonesSchema` (`zoneIds ≤ 8`), `PassAccessSchema` (pass detail card) |
| `contracts/scan.ts` | P0: five reasons, `ScanAccessSchema`, `ScanOutcome.access`, `ScanCard.access` |
| `contracts/scanners.ts` | later, additive: `ScannerSchema.zones`, `Create/UpdateScannerSchema.zoneIds`, `ScanRecordSchema.zone`, `.visit`, `ScanListQuerySchema.zoneId` |
| `contracts/orgs.ts` (g) | `OrgSchema.timeZone`, `UpdateOrgSchema.timeZone` |
| `contracts/passes.ts` (d) | `PassDetail.access: PassAccessSchema \| null` |
| `passkit/types.ts` | P0: `AccessManifest` and friends, `ScanManifest.access?` |

Routes (`modules/scan/routes-zones.ts`, `requireAdmin`, mode-free, CSRF, audited): `GET`, `POST /api/v1/scan-zones`
(tree order); `PATCH /api/v1/scan-zones/{id}`; `POST /{id}/archive`, `/restore` (children follow); `PATCH
/api/v1/scanners/{id}` takes `zoneIds`; `POST /api/v1/passes/{id}/access/reset-visits`.

### 19.9 Security and privacy

- Zones, plans and sponsors never cross orgs: zone ids are checked against the org in the service (404 body); another
  org's pass at a door is `not_found` with a random code's body; a test and a live scanner share zones, never passes.
- The sponsor is `x-scan: desk`: Door scanners, Door monitors and customers never see it.
- Customer screens get only the band (zone name on a grant), two system lines and the plan chip; a refusal never names
  the zone, the plan's hours beyond the next opening, or a suspension.
- Logs carry ids only: no zone names, inputs or sponsors.
- The photo is the anti-sharing control (`sharingProhibited` on the pass, the photo at the door). No anti-passback.

### 19.10 Files and tests

Files (AX owns unless noted; plan §3): `src/passkit/template/access/{hours,decide,scope,validate,index}.ts`,
`modules/scan/{access,zones,routes-zones,repo-zones,repo-access}.ts`, `contracts/access.ts`,
`src/web/admin/scanning/zones/**`, `src/web/admin/templates/designer/access/**`,
`src/web/admin/passes/inputs/{access-plan,access-zones}.tsx`; the blueprint package (BP). Tests: AX §6.4 (pure: spans,
schedule, DST in New York, London, Kolkata and Lord Howe, zones, guests, the gate, validation; worker: the full order
with real D1, multi-zone, the guest limit under concurrency, undo of a visit, isolation, history at a month edge,
`ready` without a write, an event scanner checking an access card in once, undo superseded and one step only, a
no-zone scanner naming no zone, a foreign zone id granting nothing, `guestUntil` with `days: 3` across a DST night
and written into `until` at issue, `timeZone` on the outcome, log hygiene; web: the week grid, the zone
tree, the pass widgets, axe at 1440/820/390 in both themes), e2e `16-scan-access`.
