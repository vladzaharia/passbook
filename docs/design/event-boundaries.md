# Event boundaries: timed renders, no versions

Upcoming events (`upcoming-events`, n3 in `next-wave.md`) carry keys that move with the clock: which event
is active, which ended events drop off (and which event past the cap of 10 moves up), and with `schedule`
the relevance windows, `relevantDate` and the expiry. Wallet only shows what the server last sent, so the
pass must change at each event's start and end with no edit.

## Decision

A boundary never makes a content version. It makes a **timed render** of the current artifact: the
time-derived keys recomputed at the boundary, stored beside the artifact with an update tag of their own.
`passes.version`, `revision`, `row_version`, `object_key` and `modified_at` do not move, so every version
fence (If-Match saves, import check and undo, bulk runs, scan sets and their undo, change-run reverts,
wallet-provider proofs on version and revision) keeps working for event passes.

Options weighed:

- **(a) Render stamp, no version.** Chosen. Signing at fetch already ships (the voided Apple variant,
  personalization), costs a few milliseconds of CPU per fetch, and a device fetches once per render.
- **(b) Boundary versions that fences see through** (one helper that skips `source = schedule:event-boundary`
  versions). Every fenced flow in five modules would need it, plus revision fences in wallet-providers and
  holders; one missed flow is a silent refusal. Boundary versions would also push real edits out of
  `retention.passVersionsKeep`, show in history, webhooks and metrics, and strip pending change messages.
- **(c) Re-sign a new artifact under the same version.** `object_key` changes fire the publish trigger
  (version row, push keyed by version, revision), so this is (b) in disguise.

## How it works

- `pass_boundaries` (migration 0205): one row per pass whose artifact lists events, for that artifact
  (`version`, `object_key`); developer orgs have none. A new artifact resets the row through a trigger and is
  due at once. `stamped_at` survives the reset, so renders stay 5 minutes apart across artifacts.
- Minute cron `passes.event_boundaries`: one `UPDATE ... RETURNING` claims due rows under a 5-minute lease,
  at most `passes.boundaryClaim` (default 4000) a tick, `passes.boundaryOrgShare` (default 2000) per org,
  orgs interleaved, live before test. Due rows of an org that is not active are parked for an hour in the
  same batch, so no claim scans them each minute. Each row becomes one
  `pass.boundary_refresh` queue job, so a big event day spreads over queue invocations.
- The job reads the row, pass and artifact `pass.json` in one query, resolves the template and runs
  `retimePass` (`src/passkit/behaviors/upcoming-events/timed.ts`) at now plus a 5-second clock margin.
  When the timed keys differ from what devices have, one job-grant batch stores them, takes a new tag from
  `revisions` (trigger) and queues a push. Then the row waits for the next start or end of the render
  (`passBoundaries`, shared with Google and Samsung), at least 5 minutes after the last render.
- A failure backs off (1 minute doubling to 1 hour); a 4xx other than 409 or 429 retires the row.
  Voided, removed, deleted and quarantined passes drop theirs.
- Apple: updated-since reads `MAX(passes.revision, pass_boundaries.stamp)`. Every file a holder gets goes
  through `timed-variant.ts`: the device fetch, the public and bundle downloads, portal and bundle Add all,
  the email attachment and the test inbox forward. It unzips the stored package, splices in the timed keys
  and signs it again; nothing is cached in R2. The fetch serves a weak ETag `W/"<sha>-t<rendered_at>"` and
  Last-Modified at the render; a publish in the second of the last render counts as a timestamp collision,
  so it never hides behind a 304. HEAD does not render.
- A publish whose build differs from the artifact only in timed keys equal to the current render is
  identical (`sameAsRender`): a sync or a save that changes nothing makes no version and no push.

## Limits

- `retimePass` takes back only what the events added: a `relevantDate` equal to the first listed start
  follows the first listed event; the expiry never moves earlier.
- Web previews and the SSR pass page show the artifact as built.
- Google and Samsung (CW11) park each wallet instance until `walletBoundaries`: `passBoundaries` over every
  input event (none capped, none dropped) and the expiry the last of them leaves, with the template's
  `fallbackMinutes`, so each start, end and expiry is one operation. The compile, the Samsung card and its
  expiry state read `timedPassJson`, the same keys at the time they run, or the pass as built when the
  behavior refuses the input (logged `TIMED_PASS_INVALID`).
