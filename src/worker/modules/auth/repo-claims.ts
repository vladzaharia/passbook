import { normalizeEmail } from '../../../shared/email.ts';
import { first } from '../../platform/db.ts';

type Db = D1Database;

/** Any sign-in identity of the account, break-glass included. */
export const hasAnyIdentity = async (db: Db, userId: string) =>
  (await first(db, 'SELECT 1 FROM auth_identities WHERE user_id = ?', [userId])) !== null;

/** The account holds a live membership that came from an invitation to this address. */
export const invitedAs = async (db: Db, userId: string, email: string) =>
  (await first(
    db,
    `SELECT 1 FROM org_memberships m JOIN org_invitations i ON i.id = m.invitation_id
     WHERE m.user_id = ? AND m.revoked_at IS NULL AND lower(i.email) = ?`,
    [userId, normalizeEmail(email)],
  )) !== null;
