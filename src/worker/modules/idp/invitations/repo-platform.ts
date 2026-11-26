import { all, batch, first, run, stmt } from '../../../platform/db.ts';
import type { ServiceContext } from '../../../platform/service-context.ts';
import { auditStmt, auditStmtWhere } from '../../audit/repo.ts';
import type { AuditEntry } from '../../audit/types.ts';

// A platform invitation has no org and its person holds no membership, so no grant principal exists: like
// repo-writes.ts, every statement is fenced in SQL by the invitation being open, and the accept is one batch keyed on
// a single gate update. None of these tables is in the guarded set.

export interface PlatformRow {
  id: string;
  email: string;
  token_hash: string;
  /** A JSON array of group keys. */
  groups: string;
  developer: number;
  created_by_user: string | null;
  created_by_key: string | null;
  created_at: number;
  expires_at: number;
  claim_until: number;
  revoked_at: number | null;
  accepted_at: number | null;
  accepted_subject: string | null;
}

const COLUMNS = `id, email, token_hash, groups, developer, created_by_user, created_by_key, created_at, expires_at,
  claim_until, revoked_at, accepted_at, accepted_subject`;

export const platformByHash = (db: D1Database, hash: string) =>
  first<PlatformRow>(db, `SELECT ${COLUMNS} FROM platform_invitations WHERE token_hash = ?`, [
    hash,
  ]);

export const platformById = (db: D1Database, id: string) =>
  first<PlatformRow>(db, `SELECT ${COLUMNS} FROM platform_invitations WHERE id = ?`, [id]);

/** Newest first, from `since`: what the console lists. */
export const listPlatform = (db: D1Database, since: number, limit: number) =>
  all<PlatformRow>(
    db,
    `SELECT ${COLUMNS} FROM platform_invitations WHERE created_at >= ? ORDER BY created_at DESC, id LIMIT ?`,
    [since, limit],
  );

/** An invitation to this address that can still be used: open and inside its claim window. */
export const openPlatformFor = (db: D1Database, email: string, now: number) =>
  first<{ id: string }>(
    db,
    `SELECT id FROM platform_invitations
     WHERE email = ? AND revoked_at IS NULL AND accepted_at IS NULL AND claim_until > ?`,
    [email, now],
  );

/** Display names of live groups by key; a key missing from the map is not a live group. */
export async function groupNames(
  db: D1Database,
  keys: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const key of keys) {
    const row = await first<{ friendly_name: string }>(
      db,
      'SELECT friendly_name FROM idp_groups WHERE key = ? AND deleted_at IS NULL',
      [key],
    );
    if (row) out.set(key, row.friendly_name);
  }
  return out;
}

export interface NewPlatform {
  id: string;
  email: string;
  hash: string;
  groups: readonly string[];
  developer: boolean;
  createdByUser: string | null;
  createdByKey: string | null;
  now: number;
  expires: number;
  /** The window to finish after a setup or claim starts here, a day past `expires`. */
  claimUntil: number;
}

/** The row and its audit entry in one batch. A group that is not live is refused by a trigger. */
export async function insertPlatform(
  ctx: ServiceContext,
  n: NewPlatform,
  audit: AuditEntry,
): Promise<void> {
  const db = ctx.env.DB;
  await batch(db, [
    stmt(
      db,
      `INSERT INTO platform_invitations (id, email, token_hash, groups, developer, created_by_user, created_by_key,
         created_at, expires_at, claim_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        n.id,
        n.email,
        n.hash,
        JSON.stringify(n.groups),
        n.developer ? 1 : 0,
        n.createdByUser,
        n.createdByKey,
        n.now,
        n.expires,
        n.claimUntil,
      ],
    ),
    auditStmt(db, ctx, audit),
  ]);
}

/** True when an open invitation was revoked. */
export async function revokePlatform(db: D1Database, id: string, now: number): Promise<boolean> {
  return (
    (
      await run(
        db,
        'UPDATE platform_invitations SET revoked_at = ? WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL',
        [now, id],
      )
    ).changes > 0
  );
}

/** A setup or a claim moves the window to at least this; a trigger refuses a decrease. */
export const widenPlatformWindow = (db: D1Database, id: string, until: number) =>
  run(
    db,
    `UPDATE platform_invitations SET claim_until = max(claim_until, ?)
     WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL`,
    [until, id],
  );

/** Records a signup token id (a trigger caps three per invitation) and moves the window out, with the audit row. */
export async function insertPlatformSetup(
  ctx: ServiceContext,
  s: { invitationId: string; tokenId: string; now: number; expires: number; claimUntil: number },
  audit: AuditEntry,
): Promise<void> {
  const db = ctx.env.DB;
  await batch(db, [
    stmt(
      db,
      'INSERT INTO platform_invitation_setups (idp_token_id, invitation_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      [s.tokenId, s.invitationId, s.now, s.expires],
    ),
    stmt(
      db,
      `UPDATE platform_invitations SET claim_until = max(claim_until, ?)
       WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL`,
      [s.claimUntil, s.invitationId],
    ),
    auditStmt(db, ctx, audit),
  ]);
}

export interface PlatformAccept {
  id: string;
  subject: string;
  /** The PassBook user, when the person signed in (developer access); null otherwise. */
  userId: string | null;
  groups: readonly string[];
  developer: boolean;
  /** Who the developer grant is by: the inviter, or the acceptor when no user invited. */
  grantedBy: string;
  memberIds: readonly string[];
  grantId: string;
  now: number;
}

/**
 * Accepts: one gate update, and every other statement keys on it, so a lost race or a closed window writes nothing.
 * The groups become `invitation` rows of the person's Polaris ID account (the reason the drain keeps), and a developer
 * invitation also writes the platform developer grant. A group that is gone or already held is skipped.
 */
export async function acceptPlatform(ctx: ServiceContext, a: PlatformAccept): Promise<boolean> {
  const db = ctx.env.DB;
  const gate = `EXISTS (SELECT 1 FROM platform_invitations WHERE id = ? AND accepted_subject = ? AND accepted_at = ?)`;
  const gateParams = [a.id, a.subject, a.now];
  const statements = [
    stmt(
      db,
      `UPDATE platform_invitations SET accepted_at = ?, accepted_subject = ?
       WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND claim_until > ?`,
      [a.now, a.subject, a.id, a.now],
    ),
    ...a.groups.map((key, i) =>
      stmt(
        db,
        `INSERT INTO idp_group_members (id, group_key, subject, user_id, source, platform_invitation_id, created_at)
         SELECT ?, ?, ?, ?, 'invitation', ?, ? WHERE ${gate}
           AND EXISTS (SELECT 1 FROM idp_groups g WHERE g.key = ? AND g.deleted_at IS NULL)
           AND NOT EXISTS (SELECT 1 FROM idp_group_members m
                           WHERE m.group_key = ? AND m.subject = ? AND m.removed_at IS NULL)`,
        [a.memberIds[i], key, a.subject, a.userId, a.id, a.now, ...gateParams, key, key, a.subject],
      ),
    ),
    ...(a.developer && a.userId
      ? [
          stmt(
            db,
            `INSERT INTO platform_role_grants (id, user_id, role, granted_by, created_at)
             SELECT ?, ?, 'developer', ?, ? WHERE ${gate}
               AND NOT EXISTS (SELECT 1 FROM platform_role_grants
                               WHERE user_id = ? AND role = 'developer' AND revoked_at IS NULL)`,
            [a.grantId, a.userId, a.grantedBy, a.now, ...gateParams, a.userId],
          ),
        ]
      : []),
    auditStmtWhere(
      db,
      ctx,
      {
        actorType: 'system',
        action: 'idp.invite_platform',
        targetType: 'platform_invitation',
        targetId: a.id,
        detail: { op: 'accept', groups: a.groups.length, developer: a.developer },
      },
      gate,
      gateParams,
    ),
  ];
  await batch(db, statements);
  const row = await platformById(db, a.id);
  return row?.accepted_subject === a.subject && row.accepted_at === a.now;
}

/** The user who made an API key, for a grant that must name a user. */
export async function keyOwner(db: D1Database, keyId: string): Promise<string | null> {
  const row = await first<{ created_by: string | null }>(
    db,
    'SELECT created_by FROM api_keys WHERE id = ?',
    [keyId],
  );
  return row?.created_by ?? null;
}
