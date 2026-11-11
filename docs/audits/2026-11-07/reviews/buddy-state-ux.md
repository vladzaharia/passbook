# Buddy mascot: product affordances and semantic-state audit

## Evidence boundary

Read-only source audit; no edits, builds, tests, audio playback, production requests, assistive-technology sessions, or hardware verification. Paths are relative to the main checkout unless prefixed **iOS**, meaning `/private/tmp/wallet-ios-scanner/`. That separate worktree is not evidence of deployment.

**Assessment:** Buddy generally helps orientation and recovery without replacing text. The main weakness is inconsistent success semantics across operational surfaces. No new mascot-only P1 security blocker was identified.

## Current state map

| Surface / persona / lifecycle action | Source-confirmed Buddy behavior |
|---|---|
| **Public authentication — holder signing in or confirming an address** | Confirmation displays a check before submission; break-glass displays a turning key. Expired links droop, throttling shows an hourglass, and access refusal uses the lock/tug scene. Identity, action and recovery remain textual. `src/worker/modules/auth/pages.ts:49–53,74–85,149–160,225–230`; `src/web/ui/art/state-art.tsx:46–72`. |
| **Public pass and portal — holder installing a pass** | Active, unregistered passes get a neutral nudge toward the badge/QR; registration produces happy/count. Voiding produces sad/tear. Removed passes currently reuse expired’s drooping-pass appearance. `src/web/portal/add/area.ts:12–20`; `add/add-block.tsx:20–70`; `holder-pass-view.tsx:90–104`. |
| **Portal — holder finding or completing their collection** | Empty lists search; loaded passes produce nudge/tuck, happy/count when all loaded live passes are registered, or sad/beat when none remain live. `src/web/portal/my-passes-page.tsx:42–56,170–172,225–230`; `ui/empty-state.tsx:49–54,114–122`. |
| **Admin — partner importing or issuing** | Upload: curious during drag, neutral after selection, riffle after 600 ms of importing, sad on refusal; completed import cheers. Newly created passes wave; newly voided passes cry. These distinguish operation completion from the resulting pass’s condition. `src/web/admin/templates/upload-drop.tsx:99–126,155–159`; `upload-page.tsx:128–140`; `passes/detail/detail-page.tsx:154–175`. |
| **Scanner — operator deciding admission/action** | Confirmed success is happy; offline queued work stays non-happy; warnings are curious; refusals shake sadly; system failures use sad/sorry. Checking becomes rummage when slow. However, the rendering boundary converts neutral to flat. `src/web/scan/machine/present.ts:46–71,188–210`; `scan-loop.tsx:243–251`. |
| **Native — operator and customer display** | Android embeds the configured verifier; iOS embeds `/scan`. The separate iOS customer route maps accepted→happy/cheer, checking→curious/search, rejected/failed→sad/sorry, ready→curious/wave. Its native fallback uses text/SF Symbols, not another mascot. Android `WebSurface.java:39–41,114`; **iOS** `ios/PassBookScanner/ScannerViewController.swift:50–52`; `src/web/scan/customer-display.tsx:24–40,76–86`; `live/customer-buddy.tsx:13–28`; `ios/PassBookScanner/CustomerDisplay.swift:4–29`. |
| **Email — recipient receiving access or a pass** | Sign-in mail is happy; address verification is curious. Pass/bundle mail uses static happy artwork, with organization opt-in defaulting off. Decorative images have empty alt text. `src/worker/email/sign-in.ts:35–39,92–101`; `pass.ts:165–168`; `bundle.ts:91–94`; `buddy.ts:23–29`; `src/shared/contracts/settings.ts:63–64`. |

### Timing, sound and accessibility

- Shared Buddy is decorative and non-focusable; textual errors remain alerts. SPA replay waits approximately 700 ms plus intersection observation, and clicks replay only decoration. Reduced motion prevents scene runs. `src/web/ui/art/buddy-art.tsx:98–108`; `base.tsx:77–78`; `replay.ts:6–13,42–65`; `src/web/ui/error-state.tsx:101–115`.
- Public nudge/tear execute directly on load; unlike acted error scenes, their animation declarations do not consume the shared 700 ms SSR delay. `src/web/ui/art/scenes/common.css:4–5`; `nudge.css:8–42`; `tear.css:8–16`.
- Scanner sound and announcements are separate commands, not information encoded only in Buddy. Sound is preference-gated; persistent live regions carry results. `src/web/scan/machine/commands.ts:166–173`; `ui/live-announcer.tsx:11–36`. Other inspected Buddy renderers attach no sound.
- Email is static, including reduced-motion use. Organizations can preview the actual renderer before saving their Buddy preference. `src/worker/email/shell.ts:22–23`; `src/web/admin/orgs/pass-email-preview.tsx:81–94`.

## Recommended role/state matrix

Reuse existing components and mappings rather than establish another mascot system. For full-body Buddy, **neutral means omitting `mood`**, not supplying `"neutral"`.

| Role | Expression / scene | Trigger and authority |
|---|---|---|
| Orient / onboard | Neutral or curious; search, inspect, nudge/tuck | An available action or genuinely empty collection; retain explicit instructions. |
| Await / process | Neutral; actual pending riffle/rummage only | Pending work, never inferred completion. |
| Confirm | Happy; wave, cheer or count | Confirmed, clearly scoped effect—not merely incomplete progress. |
| Recover | Sad plug/sorry; expired droop only for expiry | Failure reason and recovery action remain text. |
| Enforce a boundary | Restrained refusal; customer apology rather than blame | Authorization/admission decisions remain authoritative text and controls. |
| Sensitive confirmation | Still, neutral | Avoid decorative check/unlock implications before the user submits. |
| Partner email | Optional, static, organization-led | Mood describes the mail’s purpose, not guaranteed current pass validity. |

## Prioritized changes and proposed acceptance

### P2 high — Align customer-display expressions with admission state

**Persona/stage/action:** venue partner and attendee during check-in.

Main-checkout customer Buddy is happy for `heads_up`, `ready` and `undo`; only `refused` becomes flat. Yet customer-safe captions say “Please wait” or “Please see the desk.” The mood also ignores reconnection state. `src/web/scan/live/live-screen.tsx:138–154`; `src/shared/contracts/scan-setups.ts:62–65`; `src/worker/modules/scan/live-render.ts:18–34`.

**Impact [INFERENCE]:** contradictory reassurance weakens the display’s usefulness at a secure physical decision. Captions remain correct; this is not a demonstrated authorization bypass.

**Change:** land the separate iOS worktree’s outcome-aware `CustomerBuddy` mapping, apology scene and stylesheet registration together, replacing the main checkout’s blanket happy mapping.

**Acceptance, not executed:** present ok, warning, ready, refusal, undo and reconnecting states; happy must correspond only to confirmed acceptance, while text remains sufficient with Buddy hidden.

### P3 gap — Reserve completion celebrations for sufficient evidence

**Personas/actions:** partner monitoring a broadcast or readiness; holder completing installation.

- `sending` currently uses happy/count: change it to neutral/beat; retain cheer for terminal `sent`. Existing counts and progress remain authoritative. `src/web/admin/messages/detail-counts.tsx:8–12,71–98`.
- Status cheers whenever no component is failing/degraded, including configured-but-unverified or unconfigured states. Use a neutral face when readiness evidence is incomplete, without treating optional configuration as failure. Component counts already expose the distinction. `src/web/admin/status/summary.tsx:41–56`; `groups.ts:49–63`.
- Collection count celebrates loaded pages without considering another page. Gate happy/count on pagination completeness or an authoritative aggregate; do not fetch every page merely for decoration. `src/web/portal/my-passes-page.tsx:44–49,170,225–230`; `api.ts:25–31`.

**Impact [INFERENCE]:** partners and holders receive a completion cue before the relevant scope is known complete.

**Acceptance, not executed:** hold a broadcast in sending; show unverified configuration; load an entirely registered first page with an unregistered subsequent page. None should imply completed scope.

### P3 gap — Reset Buddy when code resend succeeds

**Persona/stage/action:** holder recovering from a failed or expired sign-in attempt.

Successful resend clears field errors but does not call `scene.send()`. Buddy can retain its previous failure until typing resumes. Expiry classification also continues using the original `sentAt`. `src/web/portal/login-code-face.tsx:59–61,77–85`; `login-scene.tsx:75–89`.

**Change:** reset the scene on successful resend and renew the timestamp used for Buddy’s expiry classification. Keep happy reserved for successful authentication.

**Acceptance, not executed:** cause expiry/error, resend successfully without typing, then enter a wrong fresh code. Buddy should recover to neutral, then show a flat slip—not stale expiry.

### P3 gap — Give operational states one valid cameo

**Persona/stage/action:** scanner operator pausing, recovering or reviewing a shift.

Paused/unavailable loop cards render a happy BootCard Buddy alongside the unconditional dock Buddy; boot-only suppression does not apply to loop/result mode. `src/web/scan/scan-loop.tsx:172–182,213–252`; `app.tsx:116`; `ui/scan-boot.css:15–16`.

**Change:** suppress the dock cameo when BootCard owns it; make blocking/paused expressions state-appropriate. Preserve neutral by omitting mood rather than converting it to flat (`scan-loop.tsx:247`). Replace unsupported `scene="scan" pose="count"` with supported `scene="count"` when a loaded summary warrants it (`ui/shift-sheet.tsx:43`; `buddy/beats-1.css:35–94`; `ui/art/scenes/count.css:8–28`).

**Acceptance, not executed:** pause, invalidate pairing, and load/fail shift summary; show one Buddy with a supported, truthful state.

### P3 design recommendation — Separate lifecycle and sensitive-decision symbols

Use sad/beat without the expired prop for removed passes (`src/web/portal/holder-pass-view.tsx:95–100`). For confirmation/break-glass, consider still neutral art until submission rather than pre-submission check/key-turn symbolism (`src/web/ui/art/state-art.tsx:60–72`). These are semantic recommendations, not claimed security vulnerabilities.

Existing scanner entrance, double-delay and sound-persistence findings remain covered by `docs/audits/2026-11-07/reviews/06-cohesion-buddy.md`; do not count them again as new findings.
