import { first } from '../../platform/db.ts';
import { rolesGranting } from '../orgs/access.ts';
import type { TemplateCapability } from './access.ts';

/** The member a key acts as: the user who created it, or null once that user is gone. */
export async function keyCreator(db: D1Database, keyId: string): Promise<string | null> {
  const row = await first<{ created_by: string | null }>(
    db,
    'SELECT created_by FROM api_keys WHERE id = ?',
    [keyId],
  );
  return row?.created_by ?? null;
}

/** The creator's live membership in the org when its roles grant the capability, else null. */
export async function creatorMembership(
  db: D1Database,
  orgId: string,
  userId: string,
  capability: TemplateCapability,
): Promise<string | null> {
  const row = await first<{ id: string }>(
    db,
    `SELECT m.id FROM org_memberships m JOIN users u ON u.id = m.user_id
     WHERE m.org_id = ? AND m.user_id = ? AND m.revoked_at IS NULL AND u.status = 'active'
       AND EXISTS (SELECT 1 FROM json_each(m.roles) r JOIN json_each(?) g ON g.value = r.value WHERE r.type = 'text')`,
    [orgId, userId, JSON.stringify(rolesGranting(capability))],
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
