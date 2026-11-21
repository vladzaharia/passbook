import type { Grant } from '../../platform/authority.ts';
import type { SqlValue } from '../../platform/db.ts';

/** Active people with no PIN tag and no reset flag yet. */
export const untaggedCountStatement = (orgId: string): [string, SqlValue[]] => [
  `SELECT COUNT(*) AS n FROM scan_staff
   WHERE org_id = ? AND disabled_at IS NULL AND pin_tag IS NULL AND pin_reset_required = 0`,
  [orgId],
];

/** The flag only: no role, PIN hash or disabled time moves, so no epoch does. */
export const untaggedFlagUpdate = (g: Grant) =>
  g.update('scan_staff', {
    set: { pin_reset_required: 1 },
    where: { pin_tag: null, disabled_at: null, pin_reset_required: 0 },
  });
