import { first } from '../../platform/db.ts';
import { rolesGranting } from '../orgs/access.ts';
import type { TemplateCapability } from './access.ts';

/** The member a key acts as: a personal key's membership, else the user who created it (null once gone). */
export async function keyActor(
  db: D1Database,
  keyId: string,
): Promise<{ userId: string | null; membershipId: string | null }> {
  const row = await first<{
    created_by: string | null;
    kind: string;
    membership_id: string | null;
  }>(db, 'SELECT created_by, kind, membership_id FROM api_keys WHERE id = ?', [keyId]);
  if (row?.kind === 'personal') {
    const member = row.membership_id
      ? await first<{ user_id: string }>(db, 'SELECT user_id FROM org_memberships WHERE id = ?', [
          row.membership_id,
        ])
      : null;
    return { userId: member?.user_id ?? null, membershipId: row.membership_id };
  }
  return { userId: row?.created_by ?? null, membershipId: null };
}

/** The acting user's live membership in the org when its roles grant the capability, else null; a personal key names its own. */
export async function creatorMembership(
  db: D1Database,
  orgId: string,
  userId: string,
  capability: TemplateCapability,
  membershipId: string | null = null,
): Promise<string | null> {
  const row = await first<{ id: string }>(
    db,
    `SELECT m.id FROM org_memberships m JOIN users u ON u.id = m.user_id
     WHERE m.org_id = ? AND m.user_id = ? AND (? IS NULL OR m.id = ?)
       AND m.revoked_at IS NULL AND u.status = 'active'
       AND EXISTS (SELECT 1 FROM json_each(m.roles) r JOIN json_each(?) g ON g.value = r.value WHERE r.type = 'text')`,
    [orgId, userId, membershipId, membershipId, JSON.stringify(rolesGranting(capability))],
  );
  return row?.id ?? null;
}

/** SQL for "the creator's membership is unrevoked, its user active and its roles grant the capability". */
export const creatorGrantsSql = `EXISTS (SELECT 1 FROM org_memberships m JOIN users u ON u.id = m.user_id
  WHERE m.id = ? AND m.user_id = ? AND m.revoked_at IS NULL AND u.status = 'active'
    AND EXISTS (SELECT 1 FROM json_each(m.roles) r JOIN json_each(?) g ON g.value = r.value WHERE r.type = 'text'))`;

export const creatorGrantsParams = (
  membershipId: string,
  userId: string,
  capability: TemplateCapability,
) => [membershipId, userId, JSON.stringify(rolesGranting(capability))];
