import { type GrantCond, tenantSql } from '../../platform/authority-cond.ts';

/**
 * A write condition: no scan of this pass still stands apart from `exceptId` (an undo is not one,
 * nor is an undone scan). It is part of the pass write, so a scan that commits after the undo
 * decided keeps the start.
 */
export const noOtherStandingScan = (passId: string, exceptId: string): GrantCond =>
  tenantSql(
    `NOT EXISTS (SELECT 1 FROM scans s WHERE s.org_id = {org} AND s.mode = {mode}
       AND s.pass_id = ? AND s.id != ? AND s.state = 'done' AND s.outcome = 'ok'
       AND s.undoes IS NULL AND s.undone_by IS NULL)`,
    [passId, exceptId],
  );
