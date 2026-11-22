# Google Wallet change messages: send path

Status: decided, 2026-11-22. Base `origin/main` 0a1fafea8. Read-only design (Opus). Reads with `docs/design/wallet-providers/architecture.md` (6.1, 6.3), `google-wallet.md` (3, 9), `product.md` (row "Messages and broadcasts"). This file replaces architecture 6.3 and the "Message / broadcast" row of 6.1 for Google.

## 0. Decisions

1. **One notifying call:** object `addMessage` with `messageType: TEXT_AND_NOTIFY`. It is the only call Google documents as firing an Android notification.
2. **Never:** class `addMessage` (it reaches every holder of the class, not the targeted passes), `notifyPreference` (loyalty and event fields only, separate cap, transient), `TEXT_AND_NOTIFY` inside a PATCH, PUT or insert body.
3. **PassBook owns the object's `messages` array.** Every object upsert carries `messages` = the newest delivered messages of the last 30 days, at most 9, all `TEXT`; a voided pass carries only the voided message. The tenth slot is kept for the next `addMessage`.
4. **One Google message per sync operation.** It joins every change message of the versions the operation brings to Google, front to back. One update costs one notification from Google's 3 a day.
5. **Messages come from the stored pass versions**, never from broadcasts or publish options. A Google message exists exactly when an Apple version in the range carried a `changeMessage` on a field whose value moved. Silent edits, clearing follow-ups and Apple-over-budget rebuilds strip `changeMessage` (`passes/change-messages.ts:44-81`, `passes/publish-flow-changed.ts:22-49`), so they are silent on Google too.
6. **Base version:** the newer of (a) the pass version of the instance's last succeeded upsert and (b) the target version of its last message that was sent or settled. A first object never notifies (Apple rule: a first version never notifies).
7. **Order:** object write first, message second. A message never goes before the content it describes, and a message failure never fails the object write.
8. **At most once.** A message whose transport is ambiguous is checked with one GET and never re-sent. A duplicate notification is worse than a missed one; the content is on the card either way.
9. **Budget:** 3 notifying messages per Google object per rolling 24 h (`PROVIDER_NOTIFY_LIMIT.google`, unchanged). Over it, the message goes as `TEXT`. A Google quota refusal marks the object's budget spent for 24 h from the refusal. No exemption on Google (the Apple `budgetExempt` stamp-fill rule stays Apple-only).
10. **Void, removal, retirement never call `addMessage`.** Revoke operations stay message-free so retirement settles cleanly.
11. **Ledger table** `wallet_google_messages` holds message state and the encrypted text. The pass event `wallet.messaged` records each settled outcome. The broadcast forecast and the budget read the ledger.
12. **Capability matrix:** Google `messaging.notify` becomes `difference` on all five types: Google writes the lock-screen text itself. Samsung stays `difference`.
13. **No new flag.** The step runs only inside a claimed Google upsert operation, which already sits behind `provider-policy.ts:27-30` (`ENABLED.google` false), per-org enrolment, and the typed runtime (CW9b).

## 1. Google API (checked 2026-11-22)

| Fact | Source |
| --- | --- |
| `POST walletobjects/v1/genericObject/{resourceId}/addMessage`; typed objects have the same method (`eventTicketObject`, `loyaltyObject`, `giftCardObject`, `offerObject`). Response `{ "resource": <updated object> }` | https://developers.google.com/wallet/generic/rest/v1/genericobject/addmessage |
| Body `AddMessageRequest = { "message": Message }` | https://developers.google.com/wallet/reference/rest/v1/AddMessageRequest |
| `Message`: `id`, `header`, `body`, `localizedHeader`, `localizedBody`, `displayInterval`, `messageType` (`TEXT` default: card details only; `TEXT_AND_NOTIFY`: card details plus an Android notification). Ids are not deduplicated by Google ("you must choose a sensible ID") | https://developers.google.com/wallet/reference/rest/v1/Message |
| "You may send a maximum of 3 messages that trigger a push notification in a 24 hour period." Over: "QuotaExceededException"; further updates may use `TEXT`. Holders need Wallet notifications on. "The push notification users see on their lock screen is controlled by Google Wallet." | https://developers.google.com/wallet/generic/use-cases/trigger-push-notifications |
| Google "may throttle your push notification delivery quota if it deems you are spamming". Opening the notification shows a "View message" callout. `notifyPreference` exists only for loyalty points/tier and similar fields | https://developers.google.com/wallet/retail/loyalty-cards/use-cases/trigger-push-notifications |
| `GenericObject` has no `notifyPreference` | https://developers.google.com/wallet/generic/rest/v1/genericobject |
| Error catalog lists 400, 403, 404, 409 only; no status for the quota error | https://developers.google.com/wallet/tickets/events/resources/error-codes |

Not documented, verified in demo mode before go-live (section 11): the quota error's HTTP status and body; whether the 3 are counted per object; whether a PATCH carrying `TEXT` messages re-highlights or notifies; the per-object message cap (PassBook assumes 10, as `google/shapes.ts:85` already enforces); whether `addMessage` with an existing id duplicates.

## 2. Where it plugs in

Today nothing sends a Google message: the compiler emits `messages` only for a voided pass (`src/passkit/wallets/google/parts.ts:174-186`), `google-rest.ts` has no `addMessage` and handles Generic only (`google-rest.ts:15`), and the runtime fetch allowlist refuses any `/addMessage` path (`runtime-core.ts:130-142`). Worse, Google upserts cannot run at all yet: Google publishes only schema 2 (`projection-contract.ts:152-154`), and the sync operation renders schema 1 only (`render-projection.ts:154`, `sync-operation-google.ts:81`; `compiledRuntime` is false, `render-projection.ts:274-292`). So the send step is built on the typed runtime (CW9b), which compiles at claim time.

Contract asked of CW9b (the send step depends on these):
- The upsert operation compiles the object for `op.passVersion` and exposes the compiled `objectBody` before the PATCH, so the send step can overlay `messages`.
- The REST client takes the typed resource name (`genericObject`, `eventTicketObject`, `loyaltyObject`, `giftCardObject`, `offerObject`).
- The synchronous first-tap build (architecture 6.2) runs through `runWalletProviderOperation`, so it leaves a succeeded upsert row with its `pass_version`. Otherwise the base is unknown and the first change after a save is silent.

## 3. What goes to Google per source

| Source | Stored pass version | Apple | Google calls in the upsert operation |
| --- | --- | --- | --- |
| Editor save with notify | moved fields keep or get `changeMessage` (`<Label> is now %@`) | push; lock-screen text | PATCH class if changed; PATCH object with `messages` = history; `addMessage` TEXT_AND_NOTIFY |
| Connection sync, template `changeMessage` | template messages stay | same | same |
| Broadcast message (`kind` message) | `messaging.input` field = text, `changeMessage` `%@` (`broadcasts/apply.ts:101,126-147`) | same | same; body = the message |
| Change run with text | first moved field carries the run's text (`apply-change.ts:136-138`) | same | same; body = that text |
| Scan stamp that fills a card (`budgetExempt`) | message kept past Apple's limit | push | same; `TEXT` when Google's own budget is spent |
| Silent edit, clearing follow-up, Apple over budget | no `changeMessage` | silent push | PATCH object only |
| Two notifying versions before one drain | v5, v6 | two pushes | one operation, one message with both texts (section 4) |
| Re-queue of the same pass version (rotation, release, policy revision) | none new | none | PATCH only; base already covers it |
| Void, removal, retirement | voided | push | revoke operation: no `addMessage` (decision 10) |
| Unvoid | restored | push | PATCH object with `messages` = history (drops the voided message; today it would stay on the card); a message only if fields moved since the base |

## 4. The message (pure, `src/passkit/wallets/google/messages.ts`)

```ts
/** `versions[0]` is the base; the rest follow in order up to the target. Null when nothing notifies. */
export function googleChangeMessage(versions: readonly PassJson[]): { header: string; body: string } | null;
/** The object's `messages`: delivered history as TEXT (newest 9 of the last 30 days, oldest first), or the voided message only. */
export function withMessageHistory(objectBody: GoogleObjectCommon, history: readonly DeliveredMessage[], voided: boolean): GoogleObjectCommon;
```

Rules for `googleChangeMessage`:
1. Fewer than two versions: null.
2. For each consecutive pair (v[i-1], v[i]), fields come from `buildFields(pass, styleOf(pass))` (`view-fields.ts`), matched by `key` across groups (Apple's rule, `change-messages.ts:10-22`). A field notifies in v[i] when it has a string `changeMessage`, existed in v[i-1], and its JSON `value` differs. A new field is not a change.
3. Per key, keep the latest version where it notified, and only if its value at the target equals its value in that version. A later silent move drops it, even if the value moves back.
4. Text: the `changeMessage` with `%@` replaced by the target's value as the Google text module shows it (`bodyOf`, `google/fields.ts:73`, exported) and `%%` by `%`, in one left-to-right pass. Then `sanitizeText`.
5. Body: the texts in the target's front-to-back field order, identical lines once (poster templates carry a field in two dictionaries), joined with `\n`, shortened to `TEXT.body` (500) with `…`. Header: the target's `organizationName`, shortened to `TEXT.title`.
6. A voided target: null. Default language only (no `localizedBody`).

Range read: `pass_versions` rows from base to target with `pass_json` present, at most 21. A gap, a purged row, or more than 20 versions: diff base against target only; base or target missing: no message (log `wallet.google_message_no_base`, info).

## 5. Ledger (`migrations/00NN_wallet_google_messages.sql`, next free number at branch time)

```sql
CREATE TABLE wallet_google_messages (
  id TEXT PRIMARY KEY,                    -- UUIDv7 from ctx.ids.id(); Google id is 'pbm_' || 32 hex of it
  instance_id TEXT NOT NULL REFERENCES wallet_provider_instances(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL REFERENCES wallet_provider_instance_operations(id) ON DELETE CASCADE,
  base_version INTEGER NOT NULL CHECK (base_version > 0),
  target_version INTEGER NOT NULL CHECK (target_version > base_version),
  notify INTEGER NOT NULL CHECK (notify IN (0, 1)),
  state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'notified', 'text', 'failed', 'unknown', 'superseded')),
  reason TEXT CHECK (reason IS NULL OR reason IN ('budget', 'quota', 'refused', 'unconfirmed', 'rate_limited')),
  http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  tries INTEGER NOT NULL DEFAULT 0 CHECK (tries BETWEEN 0 AND 8),
  kek_version INTEGER NOT NULL, iv BLOB NOT NULL, wrapped_dek BLOB NOT NULL, ciphertext BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  settled_at INTEGER,
  UNIQUE (instance_id, base_version, target_version),
  CHECK ((state IN ('notified', 'text', 'failed', 'unknown')) = (settled_at IS NOT NULL))
);
CREATE UNIQUE INDEX wallet_google_messages_one_open ON wallet_google_messages (instance_id) WHERE state IN ('pending', 'sending');
CREATE INDEX wallet_google_messages_settled ON wallet_google_messages (instance_id, state, settled_at);
-- Triggers: id, instance_id, base_version, target_version immutable; no update out of a settled state or 'superseded'.
```

- `ciphertext` is `{header, body}` JSON under `platform/crypto.ts` envelope encryption, AAD `wallet-google-message-v1|<instance_id>|<id>`, the same treatment as provider outcomes (`wallet_provider_instance_outcomes`). The text carries field values, so it is never logged, never in an event, never in a log field.
- No `org_id`, `mode` or `pass_id` column (scoped through the instance, like outcomes), so `platform/authority-bearing-tables.ts` is untouched.
- Every write is `INSERT/UPDATE ... SELECT ... FROM wallet_provider_instance_operations op JOIN wallet_provider_instances i ... WHERE op.id = ? AND op.claim_hash = ? AND op.state IN ('claimed', 'uncertain') AND {grant}` through `walletQueueGrant` (`repo-instance-outcomes.ts:34-63` is the pattern). A lost claim cannot move a message.
- Retention: the minute drain deletes settled and superseded rows older than 35 days, 100 per run. `sending` and `pending` rows are never purged.

States: `pending` (built, not sent, or a rate-limited try) -> `sending` (written immediately before the POST, `tries + 1`) -> `notified` | `text` | `failed` | `unknown`; `pending` -> `superseded` when a newer target replaces it.

## 6. The send step (`wallet-providers/sync-operation-google-messages.ts`)

Called from the CW9b Google upsert in `sync-operation-google.ts`, in this order:

```
prepare = prepareGoogleMessages(execution, scope)
  - open row in 'sending' (a crashed try): GET the object (stage google-object); id present -> notified/text by
    its messageType; absent -> unknown. GET fails -> stays 'sending', the step sends nothing this time.
  - base = max(last succeeded upsert pass_version, max target_version of rows in sending|notified|text|failed|unknown)
  - history = notified|text rows settled in the last 30 days, newest 9, decrypted
objectBody = withMessageHistory(compiled.objectBody, history, view.validity.voided)
upsert class; upsert object(objectBody)                      // unchanged CW9b calls
sendGoogleMessage(execution, scope, prepare.base, op.passVersion)
complete(success)
```

`sendGoogleMessage`:
1. `target <= base` or no base: return.
2. Read the version range (section 4), build the message; null: return.
3. Budget (section 7): `notify` true or false.
4. One batch: mark other `pending` rows of the instance `superseded`; insert the row for (instance, base, target), or reuse it when it is `pending`; set `sending`, `operation_id`, `tries + 1`. If the row exists and is settled: return (a re-queue of the same versions).
5. POST `addMessage` `{ message: { id, header, body, messageType } }` (stage `google-message`).
6. Settle by section 8. Settling writes the state, `reason`, `http_status`, `settled_at` and the `wallet.messaged` event in one batch, the event guarded by `EXISTS (row in that settled state)` like `walletHolderEventStmt` (`repo-holder-events.ts:11-41`), so it is written once.

Request budget per notifying update: class PATCH, object PATCH, `addMessage`, plus at most one GET or one `TEXT` fallback. Lease 120 s; each call is bounded at 10 s (`google-errors.ts:44`).

## 7. Budget and quota

- `googleNotifyBudget(instance, now)`: `used` = `notified` rows with `settled_at > now - 24 h`; `quotaAt` = newest `reason = 'quota'` row in the same window. Allowed when `used < 3` and no `quotaAt`. `resetsAt` = `quotaAt + 24 h` when refused, else oldest counted `settled_at + 24 h`.
- Not allowed: the message goes as `TEXT`, `reason = 'budget'`. Google is not called with `TEXT_AND_NOTIFY`.
- **Google refuses (quota) but the update succeeded:** the object PATCH already succeeded, so the card shows the new values. The same message (same id) is sent again as `TEXT` in the same operation; the row settles `text`, `reason = 'quota'`; the object's budget is spent until refusal + 24 h; the event says `outcome: 'text', reason: 'quota'`; the operation succeeds. The message is never upgraded to a notification later. Apple is unaffected. Log `wallet.google_message_quota` (info, `code: 'WALLET_GOOGLE_NOTIFY_QUOTA'`, `orgId`).
- Quota detection, one function `isGoogleNotifyQuota(status, body)` in `google-errors.ts`: status 400, 403 or 429 and the JSON body's `error.message`, `error.status` or any `error.errors[].reason` contains `QuotaExceeded` (case-insensitive). The client reads at most 8 KiB of the error body for this check only; it never logs it. Safety net: a 429 without the marker on a `TEXT_AND_NOTIFY` row whose `tries >= 2` is treated as quota. The demo-mode fixture (section 11, V1) pins the real shape.
- `providerBudgets` (`notify-budget.ts:24-40`) and `providerNotifiedSince` (`repo-notify-budget.ts`) read the ledger for the pass's active Google instance. That also fixes today's count, which sees `message.applied` only and never `schedule.applied` (`repo-notify-budget.ts:13`). Samsung is dropped from `providerBudgets`: it has no notifying call, and its limit of 0 now shows "Samsung Wallet: daily limit reached" on every message (`notify-budget.ts:14`, `sync-labels.ts:56-64`). `BudgetOutcome` loses `'sent'`: the forecast in `message.applied` stays `deferred | over`; the ledger and `wallet.messaged` are the truth.

## 8. Errors and retries

| `addMessage` result | Row | Operation |
| --- | --- | --- |
| 2xx | `notified` (TEXT_AND_NOTIFY) or `text` (`reason` budget) | continues to success |
| Quota (section 7) on TEXT_AND_NOTIFY | resend as `TEXT`; 2xx: `text`/`quota`; refused: `failed`/`refused` | success |
| 429 without quota marker | `pending`, `reason = 'rate_limited'`; at `tries` 8 it settles `failed`/`rate_limited` | rethrow: `classifyWalletSyncFailure` retries with `Retry-After` (`sync-errors.ts:96-104`); the retry re-PATCHes and reuses the row, so one message |
| 401 on a cached token | `pending` | rethrow (one retry mints a token) |
| Not sent: fence lost before the fetch, non-ambiguous runtime error | `pending` first, then `holdClaim` / rethrow | as today |
| Ambiguous: timeout, network, 5xx, capture failure | one GET: present -> `notified`/`text`; absent -> `unknown`/`unconfirmed`; GET fails -> stays `sending` | success (the object write is done); never `uncertain` because of a message |
| 400, 403, 404, 409, fresh 401 | `failed`/`refused` with `http_status` | success |

The message step catches its own errors. Only rate limiting, a stale token and fence loss leave it, so a message can never turn a finished object write into `uncertain` (`sync-errors.ts:82-95`). Log codes: `WALLET_GOOGLE_MESSAGE_REFUSED` (warn, with `httpStatus`), `WALLET_GOOGLE_MESSAGE_UNCONFIRMED` (warn).

Idempotency, case by case:
- Retry of the same operation: same (base, target), same row and Google id; a settled row is never sent again.
- Re-queue of the same pass version (`lifecycle-instance-schedule.ts:102-121` hashes account revision and policy): same (base, target), settled, nothing sent.
- A newer version before the old operation sent: the older `pending` row is superseded; the newer diff from the same base includes its change (section 4 rule 3).
- Crash after Google accepted, before settling: the claim expires to `uncertain` (`repo-instance-claims.ts:106-135`); after settlement the next run's `prepare` GET finds the id and settles `notified`, and the PATCH history keeps it. No second notification.
- The message id is the ledger row id, not the operation id (architecture 6.3 said operation id): operation ids change on every re-queue and would notify again.

## 9. Events and the sync log

- New kind `wallet.messaged` in `EVENT_KINDS`, group `delivery` (`src/shared/contracts/events.ts:12-49`). `data: { provider: 'google', outcome: 'notified' | 'text' | 'failed' | 'unknown', reason?: 'budget' | 'quota' }`. Never the text. No migration: kinds are app-validated (`migrations/0010_events.sql:8`).
- Sync log (`src/web/admin/passes/detail/sync-labels.ts`, `sync-model.ts`): title "Wallet message"; `walletDetail` already names the wallet for `wallet.*` kinds. Facts: `notified` "Notified"; `text` "Daily limit reached"; `failed` "Not accepted"; `unknown` "Not confirmed". This gives the ledger product.md asks for (`notified`, `updated only`, none without an instance).
- `message.applied` and `schedule.applied` keep the forecast as they are (`broadcasts/apply.ts:153-168`, `apply-change.ts:170-186`).

## 10. Capability matrix

- `google/capabilities.ts`: `'messaging.notify': 'difference'` in `BEST` (today `supportOf` falls through to `native`, `capabilities.ts:75-86`).
- Every Google compiler notes, when `view.messaging.fields.length > 0`: capability `messaging.notify`, path `''`, support `difference`, message "Google Wallet writes the alert; the message shows on the pass." (Samsung's twin is `samsung/dates.ts:68-74`.)
- `capabilities.test.ts` `exercised()` adds `messaging.notify` when the view has messaging fields.
- `COMPILER_REVISION` 3 -> 4. A difference adds no omission, so approved schema 2 releases carry forward (`projection-pins.ts:97-104`) and offers do not pause.
- `npm run gen` rewrites `src/generated/wallet-capabilities.ts` and `docs/design/wallet-providers/capabilities.md`; row 46 becomes `difference` in all eight columns.

## 11. Testing (fetch blocked; stub `globalThis.fetch` with `createMockWallets().handle` and restore)

Mock (`test/mock-wallets/index.ts`): `POST /{genericObject|eventTicketObject|loyaltyObject|giftCardObject|offerObject}/{id}/addMessage` appends to the stored object's `messages` and returns `{resource}`; counts `TEXT_AND_NOTIFY` per object over an injected clock; the fourth in 24 h returns 429 `{"error":{"code":429,"message":"QuotaExceededException: ...","status":"RESOURCE_EXHAUSTED"}}` until the recorded fixture replaces it; more than 10 messages returns 400. `failNext` covers 429, 5xx and timeouts. `state()` exposes per-object messages and notify counts.

Unit, `src/passkit/wallets/google/messages.test.ts`: one version -> null; a moved field with `Tier is now %@` -> `Tier is now Gold`, header = org; `%%`; date and currency formatting equal the text module; a new field and an unmoved field -> nothing; two fields in front-to-back order; v5 notifies A, v6 notifies B (A stripped) -> both; A moved silently after notifying -> dropped; control characters removed; 600 characters cut to 500 with `…`; voided -> null; history: 12 delivered -> newest 9 as `TEXT`, oldest first; older than 30 days dropped; voided -> voided message only.

Unit, `google-errors.test.ts`: `isGoogleNotifyQuota` for 429, 400 and 403 bodies naming the quota; a plain 429 is rate limiting; 403 `PermissionDenied` is not quota; the recorded fixture once present.

Worker, `sync-operation-google-messages.test.ts`:
1. Edit with change message -> class PATCH, object PATCH (`messages: []`), `addMessage` TEXT_AND_NOTIFY; row `notified`; one `wallet.messaged`; operation `succeeded`; outcome stage `google-message` recorded.
2. Broadcast -> body is the broadcast text.
3. Fourth notifying change in 24 h -> `TEXT`, `budget`; no TEXT_AND_NOTIFY request.
4. Mock seeded with 3 notifications PassBook did not count -> quota, `TEXT` resend in the same operation, `text`/`quota`; the next message inside 24 h goes `TEXT` without trying.
5. `addMessage` timeout -> one GET; present -> `notified`, absent -> `unknown`; never a second POST; operation `succeeded`.
6. A row left `sending` -> next run GETs before the PATCH; present -> `notified`, kept in the PATCH history, not re-sent.
7. Plain 429 -> operation `retry`; the retry sends once with the same Google id.
8. Re-queue of the same pass version (account rotation) -> no message.
9. Silent edit and Apple over budget -> no `addMessage`.
10. Unvoid -> PATCH `messages` without the voided message.
11. 11 delivered -> PATCH carries 9.
12. Revoke -> no `addMessage`.
13. Fence lost before the POST -> row `pending`, not `unknown`.
14. Provider not released or org not enrolled -> no request (existing gate).
15. The message text appears in no log call and no event (`ctx.log` capture).
16. Purge: rows older than 35 days removed, `sending` kept.
17. `providerBudgets` reads the ledger; Samsung absent (`broadcasts/provider-budget.test.ts` updated).

Capability truth and matrix drift run in `npm run check` as today. E2E: `e2e/32-mock-wallets` gains a broadcast to a saved Google pass: the mock holds one TEXT_AND_NOTIFY message and the sync log shows "Wallet message · Google Wallet · Notified".

## 12. Dark until the owner's Google onboarding

Everything above ships dark. Nothing calls Google while `ENABLED.google` is false for the mode, the org is not enrolled, or CW9b is absent. The mock provider path (`WALLET_MOCK_PROVIDERS_URL`) exercises it in dev and e2e.

Owner run in demo mode (before lifting the gate; extends `product.md` section 5 step 7). GM2 ships an owner-run script, `tools/record-google-messages.ts`: it reads the demo service-account key from `.secrets/`, never from tests, and writes scrubbed responses to `test/fixtures/wallets/google/`:
- V1 Four TEXT_AND_NOTIFY `addMessage` calls on one saved test object within an hour: record status and body of the fourth (`add-message-quota.json`) and of a success (`add-message-ok.json`).
- V2 One more on a second object of the same class: it must notify (limit per object).
- V3 A PATCH with the same messages as `TEXT`: no notification, no new highlight. If it re-highlights, GM3 sends `messages` only when the history set changed (hash stored on the ledger's newest row).
- V4 `addMessage` with an id already on the object: record whether it duplicates (informational; the design does not depend on it).
- V5 An eleventh message: record the refusal (pins the cap of 10).
- V6 On a Pixel: what the notification says, what "View message" shows. Record for the device runbook.

## 13. Packages

| # | Package | Owns | Depends on | Model |
| --- | --- | --- | --- | --- |
| GM1 | Message derivation and matrix | `src/passkit/wallets/google/{messages,messages.test,capabilities,capabilities.test,fields,limits}.ts`, the compilers' note, `npm run gen` outputs | none; lands now | Sonnet, medium |
| GM2 | Send path | migration `00NN_wallet_google_messages.sql`; `wallet-providers/{repo-google-messages,sync-operation-google-messages,sync-operation-google,google-rest,google-errors,runtime-google,runtime-core,runtime-response,notify-budget,repo-notify-budget,repo-holder-events,sync}.ts` and tests; `tools/record-google-messages.ts` | GM1, CW9b merged | Sonnet, medium; Opus, high, review. Reason: at-most-once and fence correctness across retries and crashes |
| GM3 | Recorded fixtures | `test/fixtures/wallets/google/add-message-*.json`, `isGoogleNotifyQuota` adjust, V3 fallback if needed | owner run (section 12) | Sonnet, low |

Shared files GM2 touches (tell the integration agent): `src/shared/contracts/events.ts` (kind and group), `src/web/admin/passes/detail/sync-labels.ts` and `sync-model.ts` (n1), `test/mock-wallets/index.ts` (WA9), `src/worker/modules/broadcasts/provider-budget.test.ts` (n7), `e2e/32-mock-wallets*` (integration), `docs/design/wallet-providers/architecture.md` 6.1 "Message / broadcast" row and 6.3 (point here), `google-wallet.md` section 3 `addMessage` bullet ("Notification rate limits: UNCONFIRMED" becomes 3 per 24 h with the source above) and section 10 G15.

Not in scope, noted: the drain runs 30 operations a minute (`sync.ts:25`), so a broadcast to N Google passes reaches Google over about N/30 minutes; 3,000 passes take about 100 minutes, beyond Q5's 15-minute p95. Raising it belongs to the sync drain, not this send path.

## 14. Owner

No decision needed: the defaults above follow the owner answers and Q5/Q20. Owner action after Google onboarding: run V1-V6 in demo mode (section 12) before Google is released in `provider-policy.ts`.
