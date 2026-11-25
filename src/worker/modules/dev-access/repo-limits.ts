import type { Check } from '../../platform/authority-checks.ts';
import { withinLimit } from '../../platform/entitlements.ts';

/** `members.developers`: live sponsorships and pending invitations count together. */
export const developersLimit = (now: number): Check =>
  withinLimit(
    'members.developers',
    `SELECT (SELECT COUNT(*) FROM developer_sponsors s WHERE s.org_id = {org} AND s.ended_at IS NULL)
      + (SELECT COUNT(*) FROM developer_invitations d WHERE d.org_id = {org} AND d.revoked_at IS NULL
          AND d.accepted_at IS NULL AND d.expires_at > ?)`,
    [now],
  );
