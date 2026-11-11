# Operator and scanner controls — dedicated UX/UI audit

## Decision and evidence boundary

This is a **standalone control/settings redesign brief**, not an addition to the general platform priority report, a patch-regression review, or an implementation sign-off. Scope: scanner setup/pairing/devices/stations; sessions and layouts; events/staff/PIN; operator/scanner preferences; lookup/decisions/results; activity, live monitoring and customer displays. No application source changes are proposed as completed.

**Assessment:** retain the polished scanner/result visual language and shared UI kit, but redesign the control hierarchy around **session policy → station/source topology → device purpose → presentation → operator preferences**. The most consequential newly examined interactions are an event shortcut that loses its event, a “Find pass” action that can admit a coded pass, and blocked states that offer the wrong recovery. A visual reskin alone would preserve these problems.

**Evidence in this review:** source inspection only. No browser device is mounted in this assignment; the user prohibits network, builds and tests, so no server/browser session was started. No actual current UI route, viewport, hardware, assistive technology or reduced-motion mode was exercised. No production/external service, real partner action, credential value or live admission was used. Rendered fit/contrast/touch conclusions remain unverified.

Historical evidence reused, **not newly exercised**: [`scanner-pairing-phone.png`](../screenshots/scanner-pairing-phone.png), `/scan`, 390 × 844 CSS px (780 × 1688 image), recorded with reduced-motion emulation and keyboard input focus in [verification.md](../verification.md#browser-observations). This supports the prior pairing composition only—not the current operator, device, session or error states. Parent-produced mockups should be labelled **proposed target / synthetic state**, never screenshots of shipped behavior.

### Reuse and delta

Read and reused [scanner visuals](02-visual-scanner.md), [operator/admin workflow](04-ux-operator-admin.md), [cohesion](05-cohesion-design.md), [admin accessibility](15-a11y-customer-admin.md), [scanner accessibility](16-a11y-scanner-native.md), [platform settings](25-settings-platform.md) and [scanner settings](26-settings-scanner.md). The [scanner security](12-blue-scanner-native.md), [web/native](08-code-web-native.md) and [scan-display authoring](authoring-scan-display.md) reports supply safety dependencies for the target design.

- **Newly examined UX evidence:** event shortcut scope loss; mixed search/commit semantics; mounted blocked-state recovery; pairing-status failure visibility; session-versus-station source selection; operator activity vocabulary; live transport versus freshness; reader help that does not match the configured input.
- **Consciously reconfirmed, not new findings:** event assignment of managed children; unavailable staff administration/sign-in; legacy monitor/terminal controls lost through redirects; surface-driven authority drift; raw-preview/photo-alias privacy; cross-event uncertain retries; expired uncertainty blocking end-shift; spoken/visual verdict mismatch, camera-failure focus, inline-lookup focus restoration, short-height clipping, held Undo and repeated customer announcements. Their original reports remain the issue records.
- **Target-only recommendations:** Basic/Advanced organization, independent station topology, purpose/permission summaries, readiness checks, safer shortcuts and mockup specifications below. These are not claims that those capabilities are implemented.

## 1. Current surface and control coverage

Routes below were inspected **in source**, not opened in a browser. `?tab=scanners` is the URL for the visibly named **Devices** tab; `?tab=scans` is **Activity**.

| Surface | Current controls and useful foundation | UX boundary / evidence |
| --- | --- | --- |
| `/admin/scanning` and `?tab=sessions` | Sessions is the default; create/duplicate; organization/mode scope; summary cards. | Session-only creation is intentional. Keep it, but do not make someone who needs another device create another session. `scanning-page.tsx:23–29,49–59,75–97`; `search.ts:3–25`. |
| `/admin/scanning/sessions/:sessionId` | Add device, Scan as Admin, pause/resume, duplicate, end; policy summary; online/device/today counts; recent activity; revoked toggle. | This is the strongest current control hub. “End” is resumable, and refers to **every device**, unlike End shift. Make that distinction persistent rather than confirmation-only. `sessions/session-page.tsx:86–160,178–224`. |
| Session rules / new session | Passes, Admission, Device defaults tabs; accepted event/templates/all; time zone; check-in restrictions; staff requirement/role/re-entry rights; automatic/review flow, reader, people lookup, photos. | Tabs separate domains, not Basic/Advanced. Powerful restrictions and staff prerequisites are available before readiness is established. `sessions/session-fields.tsx:31–125,136–225,237–269`; `check-in-fields.tsx:27–135`. |
| `?tab=scanners`; session device sheet | Legacy/fleet table; session device cards; configured/effective Automatic layout; online/paired/revoked; last seen; capability badges; per-setting inheritance/reset; revision-conflict warning and dirty-dismiss protection. | Devices is labelled as inventory but its primary creates a session. Cards summarize layout, not independently authorized purpose or watch scope. `scanners/scanners-tab.tsx:55–84`; `sessions/device-card.tsx:16–104`; `sessions/device-sheet.tsx:24–171`. |
| Device/station topology | Customer device copy explicitly says it follows scanners in the same session. No distinct station/source picker occurs in the scoped UI or session/device contracts. | Current session membership is both policy grouping and display source grouping. Do not describe independent station configuration as shipped. `sessions/device-sheet.tsx:137–141`; `contracts/scanning-sessions.ts:40–92,113–120`; `scanning-workspace.ts:117–121`. |
| Pairing dialog and `/scan` pairing/confirmation | Expiring QR plus typed/copied code; pair-this-browser; paired/expired/waiting faces; explicit confirmation before pairing. | Good multimodal foundation. Poll failures are not represented as their own state; pairing a terminal is not the same operation. `pairing-face.tsx:44–76,106–188`; `scanner-api.ts:32–53`; legacy-terminal dependency in [04](04-ux-operator-admin.md). |
| `?tab=events`; `/admin/scanning/events/:eventId` | Event edit/archive, time/capacity/re-entry/matching rules, paired-readiness list, Assign scanners, Open scanner, result-screen Edit link. | Assignment still targets individual devices; Open scanner does not carry a managed-session choice. Result-screen editing links to a scanner authoring mode that the prior authoring audit found unimplemented. `event-page.tsx:79–91,99–126,145–179`; `events/assign-dialog.tsx:20–29,44–75`. |
| `?tab=staff`; `/scan` staff sign-in | Staff tab explicitly says unavailable; runtime offers staff selector and six-digit PIN when required. | The empty state suggests using scanner names, which does not fulfill staff identification/manager approval. Do not draw the target staff flow as operational without implementing its service prerequisite. `placeholder-tabs.tsx:3–10`; `boot/staff-start.tsx:22–78`; [04](04-ux-operator-admin.md#2-p2--mount-the-newly-exposed-staff-sign-in-handler). |
| `/scan` Scanner / Operator | Preflight, named scanner/staff capsule, test marker, status/count/reader chips, lookup, camera/torch when applicable; menu preferences; shift/end/unpair. Operator provides inline lookup and session activity and removes camera controls. | Distinct layouts are a strength. Effective authority, expected input behavior and scope are not equally prominent. `scan-loop.tsx:108–147,168–224`; `operator/operator-panel.tsx:61–108`; `ui/scan-menu.tsx:95–160`. |
| `/scan` lookup / result | People search, code/ID entry, selection/confirmation; system verdict and authorized actions; recent/last-scan/Undo; held results. | Code submission and people selection do not have equivalent mutation semantics. Existing accessibility and privacy dependencies apply to previews as well as result panels. `lookup/lookup-panel.tsx:71–156`; `lookup/use-lookup.ts:103–152`; [12](12-blue-scanner-native.md), [16](16-a11y-scanner-native.md). |
| `?tab=scans`; session/operator activity | Administrative filters and detail/Undo; session recent list; operator feed polling every five seconds; per-device recent and shift summary. | Similar names represent different scopes, retention and available actions. Session feed rows do not link to a receipt; operator vocabulary collapses distinct outcomes. `scans-tab.tsx:17–101`; `scans/filters.tsx:17–132`; `sessions/session-activity.tsx:7–56`; `operator/operator-panel.tsx:40–58,109–143`. |
| `/scan` Customer display / legacy Desk monitor | Separate read-only branch; generic redacted customer outcome; staff monitor rows; reconnect status; Refresh setup. | Customer display is not an operator permission level. Current customer output is generic, not the planned authored/name-bearing presentation. `scan-app.tsx:113–114`; `live/live-screen.tsx:119–211`; `live-render.ts:14–35`; [authoring](authoring-scan-display.md#3-implemented-versus-merely-possible). |

In the table, paths without a prefix are relative to `src/web/admin/scanning/`, `src/web/scan/` or `src/worker/modules/scan/` as indicated by the filename; `contracts/` means `src/shared/contracts/`. Exact full paths are given for the central observations below.

## 2. Material design observations

These priorities order **this UX redesign**, not the separate platform release triage. “Confirmed source” describes the implementation/control path; it does not assert a browser reproduction or patch introduction.

### O1 — Preserve event context through the event’s primary scanner shortcut

**High workflow priority · newly examined · confirmed source.**

Current: `src/web/admin/scanning/event-page.tsx:82–87` constructs **Open scanner** with `orgId`, `eventId` and `timeZone`, but no `setupId`, `sessionId` or explicit admin choice. `src/web/scan/scan-app.tsx:34–50` creates API scope only when both organization and setup are supplied. `src/web/scan/api/scan-api.ts:141–150,195–196` forwards only that scope; `src/worker/modules/scan/guard.ts:59–64` otherwise selects an existing paired credential. Thus a browser already paired to event B can follow event A’s button and receive its existing B scanner, rather than an A-specific selection/preflight. This is separate from the previously reported Assign scanners mismatch.

**Target:** label the event action **Open event scanner** and route through an explicit chooser of eligible sessions bound to that event, or **Create event session**. Show event, organization, mode, time zone and chosen device/purpose before enabling the read path. Never silently retarget an existing paired device; make switching an explicit, authorized scope change with pending-operation reconciliation.

**Acceptance proposal:** from B’s paired browser, open A’s action. The UI must either remain explicitly on B with a visible scope-conflict choice, or join an authorized A session after confirmation; it must not present B as if it were A.

### O2 — Separate “find a person” from “submit a code for admission”

**High workflow priority · newly examined · confirmed source.**

Current: **Find pass** submits the combined name/email/code/ID field (`src/web/scan/lookup/lookup-panel.tsx:119–140`). If that text resolves as a full code, `lookup/use-lookup.ts:105–123` calls `onCode`; Operator forwards it to `runtime.emit` (`operator/operator-panel.tsx:88–92`). Automatic flow sets door posture (`platform/runtime.ts:73–74`), and the read dispatcher produces an action, not just a lookup (`machine/reduce-read.ts:74–76`; `machine/commands.ts:117–135`). By contrast, name/email selection produces a preview requiring an explicit action. With automatic check-in configured, the same search-labelled submission can therefore mutate admission for a code.

**Target:** two task choices: **Scan / enter code** and **Find person**. The first must state its effective session/device behavior and use **Check in code** / **Check out code** / **Review code**, as applicable; the second remains non-mutating until **Check in** is chosen. Retain efficient automatic hardware/camera operation where explicitly configured; do not fix copy ambiguity by silently changing admission policy. Show system-owned direction/decision, never derive the final verdict from a configurable action label.

**Acceptance proposal:** enter a valid code and a unique person name under automatic and review configurations. Before submission, the action’s wording must predict whether admission can occur. Search/Back/Escape alone must never mutate a person-selected pass.

### O3 — Route each blocking cause to its real recovery, not generic re-pair/retry

**High recovery priority · newly examined mounted-path distinction · confirmed source.**

Current: `boot/use-scan-session.ts:103–121` distinguishes revoked, suspended and signed-out states, but `scan-app.tsx:175–178` discards that distinction and tells all of them to check the connection and retry. The running path similarly paints every `s.block` as **Pair this device again** (`scan-loop.tsx:212–223`), even though the reducer also sets suspended, signed-out and staff-required blocks (`machine/reduce-answer.ts:95–99`). A richer `BlockPanel` exists, but it is not consumed by either mounted branch; its alert/focus behavior must not be credited to these branches.

**Target:** a common reason-specific recovery card (state table below), keeping connection failures, revoked/expired credential, organization suspension, administrator sign-out, staff-required and paused/ended session separate. A worker cannot fix a suspension by re-pairing; a temporary staff requirement must not force credential removal. Keep the failed task’s safe context and explain who can resolve it.

**Acceptance proposal:** enter each block before boot and during operation. Correct primary action, status announcement and focus must appear in both paths, and re-pair must be offered only for an appropriate credential problem.

### O4 — Make display sources and authorized purpose independent of shared policy/layout

**High design/safety gate · newly examined station gap; authority defect already recorded.**

Current: session screens watch all non-revoked scanning devices in their parent (`src/worker/modules/scan/scanning-workspace.ts:117–121`; `repo-scanning-devices.ts:104–112`), and `live-render.ts:14–19` consumes that watch. Reusing a session across two physical counters therefore also shares their customer-result sources. Current customer rows are redacted; **this is not a new personal-data disclosure claim**. It is a topology/expectation gap: common admission rules do not necessarily mean two customers should see each other’s acceptance/referral signals. Meanwhile Automatic chooses Scanner/Operator at 900px, and Operator removes camera UI (`src/shared/scan-surfaces.ts:3–14`; `src/web/scan/scan-loop.tsx:108–116,200–201`). The prior audit separately demonstrated why layout normalization must not grant scanning authority.

**Target:** keep a Session for common policy; optionally group devices at a **Station / location** for physical source routing. In Add/Configure device, choose **Purpose** (Check-in device, Customer display, Read-only operations monitor), then authentication and layout. Scanner/Operator are presentations of an already-authorized check-in device—not permission roles. Display-source choice is explicit, with a readable mapping such as **Front gate scanners → Counter display**. A monitor’s broader watch scope is independently authorized. Automatic changes presentation only; resizing/renaming must not change purpose, audience, credentials or rights.

**Acceptance proposal:** two stations share one policy, each with a customer display. A result at station A reaches only its selected customer audience; an explicitly authorized operations monitor may watch both. A rename/resize/layout-only save preserves every read-only credential’s authority. This requires domain/authorization work, not a cosmetic source picker over today’s all-session watch.

### O5 — Distinguish waiting, failed observation and unknown readiness

**Medium operational priority · newly examined · confirmed source.**

Current: pairing polls state but only reads returned data (`src/web/admin/scanning/pairing-face.tsx:44–59`); its visible state continues **Waiting for the scanner…** when the poll has failed (`:106–165`). `scanner-api.ts:40–48` has no state-specific recovery, and `src/web/lib/query-client.ts:13–24` does not supply global query-error UI. Separately, device **Online** means last contact under two minutes (`src/worker/modules/scan/scanning-session-dto.ts:25–29`), not working camera, staff sign-in, current configuration or permission readiness. Capability badges do not establish a physically connected keyboard: the browser report sets `keyboard: true` (`src/web/scan/boot/use-device-report.ts:7–17`).

**Target:** retain compact statuses, but separate **Credential** (needs pairing/paired/expired/revoked), **Contact** (seen just now/last seen/offline/unknown), **Readiness** (ready/paused/staff needed/input blocked/not configured), and **Configuration freshness** (acknowledged revision/pending). Pairing needs **Waiting**, **Could not check pairing — Retry**, **Expired — New code**, **Paired**. Do not say pairing failed when only observation failed, or hardware connected when only support is known. Show the last successful check and preserve the code while recovering.

**Acceptance proposal:** fail only the pairing-status poll while the code remains valid, then pair from the scanner. The admin must see monitoring trouble, recover and learn the real paired state without inventing a second pairing. An Online device with denied camera or missing staff must not be labelled Ready.

### O6 — Preserve system outcomes and data freshness in every activity view

**Medium decision/status priority · newly examined extension of known outcome-accessibility problem.**

Current: with a known pass title, operator activity renders both `heads_up` and `refused` as **Review** (`src/web/scan/operator/operator-panel.tsx:119–139`). The session admin list uses **Not accepted** for both (`src/web/admin/scanning/sessions/session-activity.tsx:36–50`); global Activity instead retains distinct outcome pills (`scans-tab.tsx:59–65`). Also, live status means socket open (`src/web/scan/live/live-screen.tsx:66–68,138–140`): successful fallback polls update rows but do not mark a healthy backup channel (`:89–104`). A working poll-fed display can continue to say Reconnecting, without identifying the channel or last update.

**Target:** one outcome vocabulary across result, strip, Recent, operator activity, session activity, administrative detail and spoken output: **Checked in / Checked out / Needs review / Not admitted / Undone / Outcome unconfirmed**. Preserve available reason, source device, scope and timestamp for authorized staff; use explicit text plus icon, not color alone. Read-only monitoring must not acquire operator powers. Label freshness separately from transport: **Live**, **Updating via backup**, **Reconnecting · last update …**, **No source configured**. Keep customer copy generic and safe.

**Acceptance proposal:** a success, heads-up, known-pass refusal, checkout, Undo and uncertain outcome remain distinguishable in every permitted representation. Block WebSocket while allowing polling: the feed must honestly describe updating via backup, not failed admission or false live continuity.

### O7 — Make reader assistance input-specific and capability-honest

**Medium recovery priority · newly examined · confirmed source.**

Current: **Reader tips** appears whenever a configured reader exists and camera is available (`src/web/scan/ui/scan-menu.tsx:131–143`; `scan-loop.tsx:125–139`). Its fixed instructions start with holding an iPhone near a reader and using Face ID (`scan-menu.tsx:31–36`); the overlay simply renders that list (`scan-overlays.tsx:104–115`). The same control is available for hardware/keyboard-scanner configuration, for which those instructions do not explain focus, USB/Bluetooth/OS pairing or keyboard layout. Prior hardware audits also do not establish working Wallet VAS verification.

**Target:** help is scoped to the actual input: **Camera**, **USB/Bluetooth keyboard scanner**, **Native barcode**, and NFC only when supported and available. Differentiate support, permission, enabled state and recent read. Put relevant **Use camera / Enter code / Refocus reader** recovery beside the status; keep platform-specific diagnostics in Advanced. Unsupported VAS must remain explicitly unavailable, not illustrated as a working admission path.

**Acceptance proposal:** a keyboard-wedge operator receives keyboard/focus/layout instructions, not NFC tap advice. A missing permission or unsupported protocol offers a working alternative without claiming connection, decoding or verification success.

## 3. Basic / Advanced settings and ownership

**Consciously reconfirmed design gap:** the session’s three domain tabs, the device’s five overrides and the operator’s mixed menu do not constitute a Basic/Advanced policy. Do not simply put everything except the name behind Advanced. Rights, scope, current readiness and destructive impact must remain visible.

Reuse the existing `InheritSelect` pattern—**Session: current value**—and dirty-dismiss/revision-conflict handling (`sessions/surface-picker.tsx:132–160`; `device-overrides.tsx:13–89`; `device-sheet.tsx:24–42,87–104`). Every changed setting should show **effective value · source · applies when · reset**, including an explicit overridden badge. An event’s time zone takes precedence at runtime (`src/worker/modules/scan/scanning-workspace.ts:53–58`); when an event is selected, display that effective zone and its provenance rather than implying the session field controls it.

| Owner/scope | Basic — common task, visible first | Advanced — explicit disclosure, not another authority layer |
| --- | --- | --- |
| Session policy | Name; organization/mode; accepted passes/event; effective time zone; automatic versus review behavior; staff requirement and readiness; concise admission/exception permission summary. | Template/pass rule precedence; additional event restriction; validity window/duration; unusual re-entry/cooldown/direction policy; advanced limits where genuinely implemented. Show impacted devices and revision before saving. |
| Station / location **target capability** | Location name; explicit check-in sources and customer-display destination; read-only topology preview. | Multi-source/operations-monitor watch scopes and privacy-checked routing; no implicit org-wide customer destination. Implement scope enforcement before enabling these controls. |
| Device | Name; immutable/explicit authorized purpose; sign-in method; current layout and effective Automatic result; input/readiness; Pair/Recover; concise effective settings. | Per-setting overrides, individual reset and Reset all; capability diagnostics with freshness; terminal token rotation and legacy monitor watch migration where applicable. Never hide revocation or purpose behind harmless layout controls. |
| Operator preferences | Sound; Keep results until dismissed; input selection; camera/torch where relevant; effective code-submission behavior. State whether choices last for this shift/device/browser. | Camera/lens selection, reader diagnostics, keyboard layout/support details. No admission rights, accepted-event changes, privacy relaxations or unsupported protocol switches. |
| Staff and approval | Signed-in person, actual role, session/location, what actions are allowed; secure switch/sign-out and expiry. | Authorized roster/role/PIN reset administration, separate from scanner access. Manager approval is transaction-scoped and not a persistent elevation of the device. |
| Session/device lifecycle | Visible Running/Paused/Ended, recent contact, pending operations and exact scope of Pause/End/Revoke. | Receipt/revision diagnostics and audit detail. Never hide unresolved admissions or a partial completion behind a collapsed diagnostics group. |

**Menu target:** task group (**This shift**, **Recent**); preference group (**Sound**, **Keep results until dismissed**, **Input**); staff group (**Signed in as … / Switch staff**); lifecycle group (**End my shift**, **Unpair this device** or **Stop admin scanning**). Keep **Pause all session devices / End session** in authorized admin controls, not beside local preferences. Group destructive actions last and name their scope.

## 4. Ideal workflows and safety gates for every mockup

These are **recommendations**, not shipped flows. They consciously incorporate relevant prior fixes; a mockup must not imply that missing services or authorization checks already exist.

### Administrator setup

1. **Choose organization and mode, then create or select a session.** Name it and select all passes/templates/an event deliberately. Present the accepted scope and effective time zone in a persistent summary. From Events, pre-bind the chosen event through an eligible session—not a legacy child-device assignment.
2. **Review admission and staff rights.** Explain pass/template restrictions still apply. Keep ordinary re-entry policy separate from a Manager-authorized capacity exception. If staff service/roster is unavailable, do not allow a new staff-required setup to reach an apparently ready scanner. Legacy staff-required setups need an honest administrator recovery state, not a fictitious working PIN flow.
3. **Choose station/source topology where needed.** Sharing admission policy does not share customer screens by default. Read-only operations monitors are a separate purpose and audience from actionable Operator. Current all-session watching is not an implementation of station isolation.
4. **Add device to the selected session.** Purpose first, then authentication and presentation; Scanner/Operator choice does not grant rights. Pairing shows intended organization/mode/session/location/purpose before confirmation. Terminal integrations use their supported token lifecycle, never a QR path rejected by their backend. Existing watch/token management must survive migration to sessions.
5. **Readiness review.** Show observed device contact, policy acknowledgment, input/permission state, required staff and display-source mapping separately. A paired count is not proof of operational readiness. The one primary next action is Pair, Resolve setup, or Start—not a generic green Online label.
6. **Edit/reconfigure safely.** Retain drafts through validation/conflict; show affected devices and field provenance. An event/configuration/credential-generation change must reconcile original pending operations before another scope becomes active. A dialog dismissed during a pending write must not later close a new dialog or navigate to stale state; preserve the completion-ownership fix recorded in [08](08-code-web-native.md#6-p2--fence-mutation-completion-to-the-owning-dialog).

### Operator work

1. **Preflight:** session/event, organization/mode, location, actual signed-in role/unsigned role, permitted actions, expected input and submission policy. A desktop Operator layout does not imply Desk/Manager authority. Hold the read path until preflight is ready; do not turn camera on just to report capabilities.
2. **Read or search deliberately:** hardware/camera stays efficient; manual code entry states its action; people search previews and confirms. Preserve the operator’s camera/input choice through capability refreshes. No hidden hardware read may steal focus or commit an unrelated pass while the operator is editing a person/action.
3. **Decision:** authoritative system verdict/direction and required check first; only then audience-filtered identity/details and server-permitted actions. Names/action labels/template content never override the system’s decision. Capacity exception requires the correct Manager authorization; the approval is for that receipt/action, not general device elevation.
4. **After decision:** Undo describes the receipt and allowed window; keep-results applies to Undo too. The receipt, retained text and spoken message match the result. Return keyboard focus to the next appropriate input without resetting a held/uncertain task invisibly.
5. **Uncertainty:** distinguish an unsent/offline refusal from a sent operation with unknown outcome. Persist and reconcile the original receipt/key, original event/configuration and credential generation; never retry against a newly selected scope, call it Not admitted prematurely, or create an uncorrelated second admission. Expiry stops blind retries but must leave an explicit authorized resolution path.
6. **Finish:** **End my shift** summarizes this device/actor and keeps pairing, unlike End session or Unpair. Pending/expired-unknown operations lead to receipt reconciliation, not silent storage deletion or a permanently disabled button. Signing out/unpairing must not falsely report that all uncertain work is resolved.

### Activity, operations monitor and customer display

- Each feed names its scope: **This device**, **This session**, **Selected locations**, or **Organization · mode**; state retention/last update and provide authorized receipt drilldown where implemented. Filters retain context and distinguish no results, loading, stale data and failed refresh. Do not replace useful cached history with a whole-page error during pagination/refetch.
- Operations monitor remains read-only unless a distinct, explicitly authorized operational purpose/action flow is implemented. A layout selection is not that authorization. Monitor detail must not render a raw Wallet preview that exceeds the viewer’s field/asset grants.
- Customer display defaults to one mapped local audience and generic system copy: **Present your pass**, **Checking…**, **Checked in / Checked out**, **Please see staff**, or safe reconnect guidance. No history, full name, photo, staff name, refusal reason, secret field or barcode is exposed through a raw preview, thumbnail alias or hidden payload. Do not mock a personalized customer renderer as current: the existing generic redaction is the safe baseline until a separate allowlisted renderer is implemented.
- Every repeated customer result has an event-keyed announcement; successive identical labels are still distinct results. Customer-facing status and optional hardware/outside-display signals consume the same verified verdict for camera, HID and native inputs, without requiring a native-originated read ID. Preserve all correlation and privacy fixes from [08](08-code-web-native.md) and [26](26-settings-scanner.md).
- Revoke/reset outcome is truthful: separate **authorization committed revoked** from **screen/device acknowledged disconnection** if both are available. If a request outcome is unknown or only some devices confirmed a configuration change, show that partial state and reconcile it. Never draw a fully green success state based only on a local click, stale contact or an attempted kick.

## 5. Concrete status/error/recovery model

Every state needs a text label, scope, last-known safe context, one primary next action and an appropriate announcement. The following is target copy/behavior, not a description of completed implementation.

| State | Primary message / next action | Guardrail |
| --- | --- | --- |
| Session paused | **Session paused — all check-ins are stopped.** Operator: Check status / contact administrator. Admin: Resume session. | Retain pairing; do not suggest new credentials. |
| Session ended (reopenable) | **Session ended.** Admin: Reopen session; operator: contact administrator. | “Ended” is not deletion or end of this one shift. Explain that reopening restores the same scope, subject to safe reconciliation. |
| Credential revoked / expired | **This device’s access was revoked** / **Pairing expired.** Authorized Pair again. | Old credential stays denied; no local retry pretends to restore it. Purpose/audience must remain unchanged during metadata edits or recovery. |
| Administrator signed out | **Administrator sign-in expired.** Sign in, preserving explicit intended scope. | Do not fall back silently to another paired scanner or org/event. |
| Organization suspended | **Scanning is unavailable for this organization.** Contact administrator; Check status secondary. | No re-pair or client preference bypass. |
| Staff required, roster configured | **Sign in to operate this device.** Named staff selector plus labelled PIN and role summary. | Rate-limited, announced invalid/expired PIN; never persist PIN/approval in uncertainty storage. |
| Staff required, service/roster unavailable | **Staff setup is incomplete.** Administrator resolution link/instructions; protected refresh. | Do not invite impossible PIN entry or silently grant unsigned rights. |
| Camera denied/unavailable/decoder failed | Specific state plus **Enter code** or **Use reader**, Retry camera only where meaningful. | Alternative exists before focus moves to it; announce failure. Distinguish OS permission from absent hardware. |
| Pairing observation failed | **Could not check pairing. Last checked …** Retry status; preserve valid code. | This is not proof pairing failed. New code is a separate replacement with clear effect. |
| Offline, request not sent | **Connection needed — not admitted.** Restore connection / alternate authorized process. | Do not advertise offline queuing that is not implemented. |
| Sent, outcome unknown / retry expired | **Outcome unconfirmed — checking original receipt.** Reconcile / authorized resolution. | Same immutable operation scope/key; never automatically admit into another event or mark failed without evidence. |
| Capacity/duplicate/restriction decision | System-owned **Not admitted / Needs review** plus staff-safe reason and permitted next action. | Capacity exception and ordinary re-entry have distinct approval rules; customer sees only safe referral copy. |
| Concurrent settings change | **Settings changed elsewhere. Your draft is not saved.** Review latest / reload with explicit discard. | Preserve entered work until chosen; do not silently overwrite or attribute another editor’s change to this save. |
| Revoke/save partial or unknown | **Access revoked; device acknowledgment pending**, or **Could not confirm the change**, according to observed server result. | Never claim either successful revocation or successful rollback without evidence. Keep retry idempotent and outcome-specific. |
| Display disconnected / no mapped source | **Reconnecting · last update …** / **No scanner selected**; protected setup recovery. | No “Ready to scan” claim for an unconfigured source; no stale personalized customer result replay. |

## 6. Iconography, motion and accessibility direction

### Purposeful, coherent visual language

- Reuse the existing token surfaces, semantic result colors, shared dialog/sheet/form controls and scanner/result artwork. Keep one clear primary action per task; neutral settings controls must not compete with admission verdicts.
- Separate **purpose icons** (scan lines = check-in; search/desk = Operator presentation; monitor = read-only operations; visitor-facing display = customer purpose), **action icons** (QR = pair; sliders = overrides; pause/play/stop = session lifecycle; unplug/log out = device/admin exit) and **status icons** (check/warning/refusal/offline). Every unfamiliar/dangerous icon retains a visible label. Sparkles/Automatic must not suggest special authority or verified hardware.
- Show hierarchy before decoration: Session/event and state; location/source mapping; device purpose and observed contact; effective settings; Advanced diagnostics; danger actions. UserRound alone is too ambiguous to carry both staff identity and Customer display without text. Selected tiles need more than accent color; retain text/check/selected semantics.
- The existing layout picker is a labelled fieldset of pressed buttons (`sessions/surface-picker.tsx:83–128`). Prefer the established native-radio `OptionTile` interaction for a mutually exclusive choice (`src/web/ui/option-tile.tsx:23–64`) or equivalent complete radio semantics, rather than four independent toggle-like stops. This is a consistency/efficiency recommendation, not a proven AT failure of the current buttons.

### Motion has a control-state job

- Preserve the scanner’s semantic success/review/refusal motion; do not add decorative motion to policy editing or imply admission before the server confirms it.
- Short opacity/position transitions may show overlay ownership or a saved state; live updates should not move rows under a pointer or replay entrance animations for the entire feed. Busy animation exists only while corresponding work is genuinely pending and always has text.
- Reduced motion retains all meaning and focus: instant stable state or short non-moving fade, no card travel/shake/count-up required to understand an outcome. Current result and display-row styles have reduced-motion alternatives (`src/web/scan/result/motion.css:1–74`; `display/display-rows.css:278–286`); admin overlay/tab behavior also provides alternatives (`src/web/styles/kit-motion.css:213–238`; `src/web/ui/tabs.tsx:102–124`). Preserve these rather than rebuilding separate one-off animation systems.
- Keep a still, state-appropriate mascot for blocked/pending/recovery cards; the existing boot card always uses a happy scene (`ui/boot-card.tsx:30–35`), already noted in [02](02-visual-scanner.md). The mascot supplements—not replaces—status icon/copy and announcements.

### Keyboard, touch, screen reader and narrow layouts

- Minimum 44px touch controls and readable coarse-pointer text; shared kit buttons and scanner dock already provide useful foundations (`src/web/ui/button.tsx:50–57`; `src/web/scan/ui/scan-dock.css:128–158`). Assess adjacent target spacing, not just individual dimensions.
- Keep focus ownership through person search → selection → Back → commit → next search; restore modal openers and avoid stealing focus for hardware input while editing. Blocked-state and camera-failure announcements must use reachable actions, not absent conditional fields. Reuse the shared dirty-dialog and invalid-field behavior.
- Spoken verdict, activity and customer announcements must convey actual direction/outcome/required check, even for identical consecutive outcomes. Provide meaningful status text without relying on color, glyph, sound, mascot or timer. Do not expose staff/customer-inappropriate data through accessible names or off-screen content.
- Preserve panel naming when Scanning’s five tabs become a mobile Section select; this is the existing [15](15-a11y-customer-admin.md#3-preserve-panel-names-when-tabs-become-a-phone-select) issue, not a new mobile design solution. Advanced disclosure uses a proper button/expanded state and a named region; help/error/reset remain associated with their setting.
- At narrow widths, source mapping becomes a vertical **Scanner → Display** list; metadata wraps below the name; actions remain reachable and settings sheets scroll independently. At short landscape/zoom, the entire result—including verdict and actions—must remain reachable, not just its body. The existing 900px Operator layout and 1024px result breakpoint need joint coverage; source geometry concerns in [02](02-visual-scanner.md) and [16](16-a11y-scanner-native.md) remain unverified visually.
- Validate keyboard-open reflow and 200–400% zoom without page-level horizontal scrolling; a horizontal data region may scroll only in its own labelled container. Use a container-responsive result, not a desktop split solely because the viewport is wide.

## 7. Mockup-ready target briefs

All examples are synthetic, nonfunctional and **proposed**. Use one coherent light/dark token set and real labels; no live QR, barcode, PIN, token or external link. Missing backend capabilities must be annotated in the mockup caption, not pretended live by a working-looking unlabelled prototype.

### A. Administrator session/location/device control hub

**Frames:** 1440 × 1000 desktop; 390 × 844 phone. **Synthetic state:** Northwind Demo · Test; “Open day” event; “Front gate” session/location; two check-in devices, one local customer display, one explicitly read-only operations monitor.

- Header: breadcrumb, session/event, **Running · Test**, effective time zone; separate **3 of 4 recently seen** and readiness line. Primary **Add device**, secondary **Open operator**, visible **Pause session** while Running; More for duplicate and End session.
- Main: station/source topology **Entrance A + Entrance B → Counter display** with a scope label; check-in device rows show actual purpose/role, input readiness, last contact and overrides count. The operations monitor explicitly watches selected locations and is not one of the actionable operators.
- Aside (stacked on phone): **Session policy**, accepted scope, admission behavior, actual staff/exception policy, provenance and **Edit rules**; never a false “safe/ready” badge while prerequisites fail.
- Configure sheet: **Device details → Purpose/permissions (separate, explicit) → Presentation → Inputs/readiness → Advanced overrides/diagnostics → Revoke**. Ordinary rename/layout saves cannot mutate purpose or rights. Show a second state with a stale revision and retained draft.
- Pairing variation: valid code and matching intended purpose; **Could not check pairing** inline state with Retry; successful paired observation is separate from operational readiness.

### B. Operator desk: explicit read versus search

**Frames:** 1440 × 1000 and 390 × 844. Header: “Front gate · Open day · Test”; actual “Check-in staff” role; **Ready · Camera / keyboard** with observed support/permission details, not assumed physical connection. On desktop, input/work item left, scoped recent activity right; phone is one vertical task flow.

- Two clear choices: **Enter code** and **Find person**. Under Enter code: “This session checks in automatically”; primary **Check in code**. Under Find person: **Find person**, then filtered identity preview and **Check in**. Do not draw raw Wallet payload or hidden fields.
- Result: system **Checked in**, **Checked out**, **Needs review**, or **Not admitted**; staff-safe reason and one appropriate next action. Use a separate **Ask manager** capacity-exception state, not an unrestricted “Let in again.”
- Error variation: **Outcome unconfirmed · original event Open day · original receipt**; primary **Check outcome**; no green admission, different-event retry or silent clear. Recent activity names its session/location and retains each outcome as text.
- Preferences sheet: Basic first (Sound, Keep results, Input); Advanced diagnostics; scoped **End my shift** and separated **Unpair device**. An ending variation routes expired uncertainty to reconciliation.

### C. Customer display beside a read-only operations monitor

**Frames:** customer 390 × 844 / 1180 × 820; operations monitor 1440 × 1000. Customer card: generic **Checked in** or **Please see staff** only; safe mapping to Front gate, no staff reason, PII, history or operator action. Include **Reconnecting** and **No source selected** variants. An authorized setup/unlock path must not grant scan rights or reveal a PIN to customers.

The monitor names scope **Front gate + Side entrance · Test**, displays **Updating via backup · last update …**, and shows audience-filtered rows with true outcome text. A detail view stays read-only; any future operator escalation is a separate authenticated task. Show revocation as **Access revoked**, with acknowledgement pending only if that distinction is actually supplied by the server.

### D. Event-to-session and staff-required readiness

**Frames:** desktop and phone. Event primary **Open event scanner** opens eligible event-bound sessions with scope summary; no legacy child assignment. Provide explicit empty, loading, error and conflicting-existing-pairing states. A staff-required session with unavailable/unprovisioned service shows **Staff setup incomplete**, an administrator-resolution path and a blocked readiness step—not a plausible but unusable PIN form. Once the service exists, sign-in and Manager approval are separate, named, rate-limited tasks.

## 8. Proposed acceptance evidence — not executed

| Journey/state | What the implementation/mockup must establish |
| --- | --- |
| Event A action from paired event B | Intended scope is preserved or explicit conflict is shown; no silent B operation. |
| Automatic/review code versus person search | Visible action predicts mutation; people lookup stays non-mutating until the explicit action. |
| Fresh setup and fleet growth | Create session once, add subsequent devices to it, choose purpose/presentation independently, explain prerequisites. |
| Two stations sharing policy | Explicit local customer-source mapping; authorized monitor can aggregate without broadening customer audience. |
| Rename/resize/save layout | Read-only purpose and credential authority stay unchanged; previews and assets remain audience-safe across aliases. |
| Pairing pending/expired/poll failure/completed | Correct observer state, retained valid code, accurate recovery and confirmed readiness rather than inferred success. |
| Boot and in-flight revoked/expired/suspended/signed-out/staff-required | Correct cause-specific action and announcement; no universal connection/re-pair instruction. |
| Permission/reader failure and unsupported NFC/VAS | Truthful support/permission/connection states, working reachable fallback, input-specific help. |
| Sent timeout, event/config/credential change, expired unknown | Receipt-bound reconciliation; no cross-generation replay, uncorrelated duplicate, silent discard or permanent end-shift trap. |
| Capacity/re-entry/Undo | Correct independent approval, authoritative system verdict, receipt/expiry-aware Undo, held results and preserved permissions. |
| Activity/monitor/backup polling/revoke partial | Explicit scope/freshness and distinguishable decisions; truthful partial states; no lost cached data or unintended operator powers. |
| Keyboard/AT | Complete labelled workflow, return focus, event-keyed repeated announcements, valid mobile panel names, no hidden-field/privacy leak in speech. |
| Responsive/motion | 320 × 568, 390 × 844, 844 × 390, 1180 × 820, 1440 × 1000; 899/900 and 1023/1024 breakpoints; 195-CSS-pixel zoom scenario, 200–400% zoom, virtual keyboard, long names, both themes and reduced motion. Record actual route, state, viewport, screenshot and observed result when executed. |

No tests, builds, formatters, native/device checks or current browser verification were performed for this report. Prior findings and historical images are reused evidence, not fresh runtime results. The deliverable is the dedicated audit/design specification only; implementation, safety fixes and target mockups must remain explicitly distinguishable from the current source.

## 9. Additional runtime design evidence

### O8 — Make the start and recovery affordances match the active surface

**Medium discoverability priority · newly examined · confirmed source.**

- **Operator start:** `src/web/scan/app.tsx:105–117` selects the same StartPanel and withholds the sidebar/camera until the operational loop; `src/web/scan/ui/start-panel.tsx:86–96` always pairs the **Start scanning** text with a Camera icon. Yet Operator explicitly removes the camera from the available interface (`src/web/scan/scan-loop.tsx:108–116,200–201`). Target: **Open operator desk** / **Start check-in desk**, with search/desk icon and a summary of actual inputs and permissions. Keep the handheld start action camera-specific where appropriate. Include this pre-start state in mockup B, not only the attractive active desk.
- **Live recovery:** `src/web/scan/live/live-screen.tsx:203–206` offers **Refresh setup** in both monitor and customer modes. Its supplied callback is the session refetch (`src/web/scan/scan-app.tsx:113–114`); it does not restart the live-feed effect unless its actual dependencies change (`live-screen.tsx:36–118`). Target: distinguish **Reload setup** from **Reconnect feed**, with an action that operates on the failed channel. Customer-facing presentation should contain only safe result/status content; setup/reconnect diagnostics belong to a protected staff recovery surface, not a customer button that suggests it will fix the adjacent scanner. Do not remove all recovery—make it authorized and correctly labelled.

**Acceptance proposal:** before starting Operator, the action/icon promises desk work rather than camera capture; after starting, keyboard focus reaches the appropriate input. During a feed-only disconnect, the offered recovery acts on the feed and preserves scope. The public-facing customer state contains no unprotected setup control.

### Evidence constraint for reason-specific recovery

`src/web/scan/api/to-fail.ts:17–24` currently collapses several scanner 401 responses into `revoked`; boot also invokes that mapper without an explicit principal. Therefore a visual redesign alone cannot truthfully distinguish every expired/revoked/admin-session cause in the target status table. Use **This device’s access is no longer valid — Pair again** when only that fact is established; only use the more specific revoked/expired/signed-out copy after the server contract and consuming route preserve that distinction. Likewise, display acknowledgment, physical reader presence and configuration-application status must be drawn as **Unknown / Awaiting confirmation** unless the implementation can actually establish them. This is a target implementation dependency, not permission for the mockup to invent telemetry.

## 10. Additional session-policy and lifecycle evidence

### O9 — Prevent two event selectors from contradicting one another

**High workflow priority · newly examined · confirmed source.**

Current: **Passes → Accepted passes → Event** (`src/web/admin/scanning/sessions/session-fields.tsx:65–95`) and **Admission → Event restriction** (`src/web/admin/scanning/check-in-fields.tsx:49–65`) can independently select different events. `src/worker/modules/scan/scanning-sessions.ts:126–137` validates each reference but does not reject the incompatible combination. Runtime binds the accepted event to the actor (`scanning-workspace.ts:53–58`); admission then collects both actor and policy event IDs (`admission.ts:62–72`) and returns `wrong_event` when they differ (`:127–131`). An otherwise eligible pass cannot overcome an administrator-selected A/B contradiction by being scanned again.

**Target:** one visible event context. An additional restriction is Advanced only when it has a meaningful compatible effect; constrain it or explain and block incompatible settings before Save. This is distinct from both O1’s broken event shortcut and the already reported Assign scanners problem. Do not resolve it by silently ignoring a saved restriction. The effective event/time zone and both field origins must be visible in the policy summary.

**Acceptance proposal:** choose accepted Event A and additional Event B. The form and service must prevent saving that combination as a runnable setup, retain the draft, name both fields and explain the conflict. Compatible additional restrictions must remain possible.

### O10 — Bring consequential control effects out of menus and counts

**Medium clarity/discoverability priority · newly examined design recommendations, not patch bugs.**

- **Pause:** Running sessions show Add device and Scan as Admin while Pause is in More (`src/web/admin/scanning/sessions/session-page.tsx:105–140`). Server guards do enforce a non-active session for mutations (`src/worker/modules/scan/guard.ts:155–164`). Put **Pause session** visibly beside Running status, and **Resume session** visibly while paused; End remains separately destructive and explicitly resumable/reopenable. On a narrow running-session screen, protect the visible Pause action; lower-frequency setup actions can move into contextual menus. Do not animate the state to Paused before the server confirms. A failed/unknown request must not assert either a successful pause or a successful rollback.
- **Default-change impact:** cards expose only an override count (`src/web/admin/scanning/sessions/device-card.tsx:19–20,92–96`), while the runtime merges those overrides over parent defaults (`src/worker/modules/scan/scanning-workspace.ts:38–53`). Name the exceptions, such as **Overrides: reader, direction**. Before changing a default, show **Applies to 3 inheriting devices; 1 device keeps its override**, based on the actual loaded/authorized set; do not fabricate full-fleet counts from a partial page. Preserve existing individual inheritance/reset controls.
- **Dormant unsigned role:** SessionStaff always renders **Staff access without sign-in** even when sign-in is required (`src/web/admin/scanning/sessions/session-fields.tsx:185–208`), although the policy returns no unsigned role in that case (`src/worker/modules/scan/rules.ts:17–21`). Hide it behind a clearly labelled **Saved fallback — applies only when sign-in is off**, or disable it with that explanation. Preserve its saved value rather than silently discarding it when staff sign-in is toggled. Active role/authority remains a Basic, visible summary, not an Advanced exception.
- **Replacing pairing:** keep connection troubleshooting separate from **Replace pairing**. Existing confirmation already warns that the current device signs out at its next scan (`src/web/lib/confirms.ts:133–140`); carry that effect into the target pairing/device sheet. **Retry status** must not rotate or replace a code/credential. Terminal token rotation remains a distinct Advanced integration task.

**Acceptance proposal:** stop/resume multiple synthetic devices with correct confirmed/unknown status; change a default with exceptions and identify unaffected devices before Save; toggle staff sign-in while preserving and accurately labelling the dormant fallback; recover a poll without replacing pairing.

## 11. Production-boundary annotations for decision mockups

This audit deliberately does not confuse contract/design vocabulary with an implemented control. In addition to staff administration, station routing, native capability/verification and authored customer-renderer prerequisites already noted:

- **Money, stamp, amount-review and Manager-PIN controls are not a completed operational desk flow here.** The prior [scan-display authoring report](authoring-scan-display.md#3-implemented-versus-merely-possible) records that the Worker rejects non-check-in actions. The actual ready-card UI filters buttons to `check_in` (`src/web/scan/result/result-card.tsx:184–195`), and the consuming reducer accepts only available, unlocked check-in choices (`src/web/scan/machine/reduce-action.ts:8–12`). The central event dispatcher deliberately returns the unchanged state for `amount`, `review`, `confirm`, `cancel` and `approve` (`src/web/scan/machine/reduce.ts:64–71`). Type definitions or synthetic fixtures therefore do not prove that amount entry or a Manager-PIN sheet works.
- A proposed **Ask manager** / capacity-exception mockup requires both the prior server authorization fix and a real, correlated sign-in/approval consumer—not a button connected to an unchanged-state branch. Annotate it **target flow; approval service and client routing required**. Do not represent a PIN as stored or a device-wide role upgrade. If a later target includes money/stamp actions, provide action/amount review, units, allowed bounds, before/after context, confirmation and correlated receipts end to end; showing a static balance does not imply a working charge/top-up/reward action.
- The result-screen **Edit** shortcut and role-preview suggestions require the genuine authoring/preview workflow documented in the prior audit. Preserve system verdict/direction and admission policy ownership; no authored heading, icon or panel is an override of the decision. Every raw preview/asset/field projection still needs the same audience checks as the visible panel.

Additional proposed evidence: Operator pre-start and live-feed-only recovery (O8); conflicting event selections (O9); pause/default exceptions/dormant fallback/replacement pairing (O10); and real dispatch/approval boundaries for any new decision control. None was executed in this read-only assignment.
