# exitproof results

Branch fix/desk-markout-totals. Migration 0118_markout_totals.sql. Gate: capped-check exitproof PASS (30 files, 311 tests, lint, rules, typecheck, build).

## Found
- (b) was already on main (e97c8632): signed v2 proofs for auto exit, desk mark-out, undo with system/console/undo authority. Not redone.
- (a) cause: a mark-out moves `scan_presence.last_scan_id` past the check-in proof, so the 0041 capture trigger never matched and the deleted pass left the event totals. (No transition row exists for mark-out; the 0041 transition trigger itself is unchanged.)

## Changed
- 0118: new `scan_retention_capture_exit_gates` BEFORE DELETE on passes; `scan_retained_gates_insert_guard` recreated to accept the exit path as well as the old one. Retains state out / presence out for the mark-out scan. No data writes: no backfill.
- Mark-out (device and console) writes `data.effect {gateAfter, presenceAfter}` in the ledger row (not in `authority`, so authority assertions are untouched) and, for event places, sets scans.event_id from the place. `markOutEffect` in repo-mark-out.ts reads the check-in gate and presence.
- `retainedExitEffect` (scan-retention-proof-data.ts) turns it into the proof's gate/presence snapshots, MAC-bound. Null when absent: zone places and rows from before retain nothing, as before.
- test/setup/schema-snapshot.generated.json regenerated.
- Tests: occupancy/mark-out-totals.test.ts (totals intact and not inside, snapshots verify, tamper retains nothing, org/mode scoping, check-in proof untouched).

## Follow-up (same branch, second commit)
- 0118 capture and guard now cover auto exits (out_cause stay/clear/zone) as well as desk mark-outs.
- Auto exit: scans.event_id and ledger eventId are set from an event place; `data.effect` (gate, presence) signs snapshots, same `markOutEffect`.
- Undo of an event check-in: `postUndoGate`/`postUndoPresence` in the undo ledger row (not in `authority`), signed through the existing `retainedEffect`. The undo row is now captured too.
- Tests added: auto exit keeps totals with snapshots; undo of an event check-in (gate undone, presence null, not retained); undo of a re-entry after a mark-out restores the exit and the pass counts once. A mark-out itself cannot be undone (no action id), so that is tested through the re-entry.
- Changed an existing test: scan-retention-proof (occupancy fixtures) "captures the entry whose state an undo restored, not the unsigned undo row". It protected: an undo row without a proof is never captured and does not block the restored entry. Now new undo rows carry snapshots, so the undo row is captured (state in) and the entry is still captured; count stays 1. Correct because the proof now exists.
- Zone-place exits and value undos still sign null snapshots.
- Gate: capped-check PASS (30 files).

## Review follow-ups (third commit)
- Behaviour change: an auto exit at an event place now carries the event id, so its pass counts in `arrived` (everyone who arrived) and drops from `inside`, live and after deletion. Test asserts arrived 1, inside 0 before deletion. Auto exits written before this keep no event_id (new rows only, no backfill) and still do not count.
- 0118 exit capture and its guard branch now require the check-in's own proof to be current (same pass_ref, not excluded, invalidated or occupancy-invalidated) and no quarantine on the check-in. Test: an invalidated check-in proof is not kept through its exit.
- The check-in may be an undo row (an undo-restored entry); an undo row counts only with snapshots, so an undo proof from before 0118 never keeps an exit. `markOutEffect` now takes the pass's newest check-in gate (its action ref from the ledger row or the undo's signed post-undo gate). Tests for both.
- Known undercount: a gate shared across events (empty or day scope) that another event's check-in moved on no longer names this event's check-in, so the pass is not kept through its exit.
