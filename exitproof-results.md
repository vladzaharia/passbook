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

## Not done
- Auto exit still signs null snapshots. An auto exit at an event place has the same totals drop; the cron row has no event id on its scan. Name it as a follow-up.
- Undo proof unchanged (null snapshots).
- No existing security/authority test was changed. Tables touched: scan_retained_gates triggers only; none of 0115-0117's.
