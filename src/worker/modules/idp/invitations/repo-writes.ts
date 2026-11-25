import { batch, stmt } from '../../../platform/db.ts';
import type { ServiceContext } from '../../../platform/service-context.ts';
import { auditStmt, auditStmtWhere } from '../../audit/repo.ts';
import type { AuditEntry } from '../../audit/types.ts';
import type { GroupSource } from '../../dev-access/repo-sponsors.ts';
import type { InviteRow } from './repo-resolve.ts';

// Every write here is made on the strength of an invitation secret (and, to accept, a strong session) by someone who
// holds no membership yet, so no grant principal exists for it: these are the reviewed raw writes of
// tools/authority-scope-allowlists.ts, each fenced in SQL by the invitation's own open state.

const INSERT_MEMBER_SETUP =
  'INSERT INTO org_invitation_setups (idp_token_id, invitation_id, created_at, expires_at) VALUES (?, ?, ?, ?)';
const INSERT_DEVELOPER_SETUP =
  'INSERT INTO developer_invite_setups (idp_token_id, invitation_id, created_at, expires_at) VALUES (?, ?, ?, ?)';
/** A setup or a claim moves a developer invitation's window to at least this; a trigger refuses a decrease. */
const WIDEN_WINDOW = `UPDATE developer_invitations SET claim_until = max(claim_until, ?)
  WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL`;

/** The batch's own refusals: the closing check, or a second membership for one invitation (a trigger). */
function landedNot(error: unknown): boolean {
  return (
    error instanceof Error &&
    /malformed JSON|UNIQUE constraint failed: org_memberships\.invitation_id/i.test(
      `${error.message} ${String(error.cause)}`,
    )
  );
}

export interface NewSetup {
  kind: InviteRow['kind'];
  invitationId: string;
  tokenId: string;
  now: number;
  /** When the signup token ends. */
  expires: number;
  /** Developer invitations only: the window to finish moves to at least this. */
  claimUntil: number;
}

function setupStatements(
  ctx: ServiceContext,
  s: NewSetup,
  audit: AuditEntry,
): D1PreparedStatement[] {
  const db = ctx.env.DB;
  return [
    ...(s.kind === 'member'
      ? [stmt(db, INSERT_MEMBER_SETUP, [s.tokenId, s.invitationId, s.now, s.expires])]
      : [
          stmt(db, INSERT_DEVELOPER_SETUP, [s.tokenId, s.invitationId, s.now, s.expires]),
          stmt(db, WIDEN_WINDOW, [s.claimUntil, s.invitationId]),
        ]),
    auditStmt(db, ctx, audit),
  ];
}

/**
 * Records a signup token id for the invitation (a trigger caps it at three and refuses an ended invitation) and, for a
 * developer invitation, moves its claim window out. The token itself is never stored.
 */
export async function insertSetup(
  ctx: ServiceContext,
  s: NewSetup,
  audit: AuditEntry,
): Promise<void> {
  await batch(ctx.env.DB, setupStatements(ctx, s, audit));
}

export interface NewClaim {
  id: string;
  kind: InviteRow['kind'];
  invitationId: string;
  subject: string;
  now: number;
  claimUntil: number;
}

function claimStatements(
  ctx: ServiceContext,
  c: NewClaim,
  audit: AuditEntry,
): D1PreparedStatement[] {
  const db = ctx.env.DB;
  return [
    ...(c.kind === 'developer' ? [stmt(db, WIDEN_WINDOW, [c.claimUntil, c.invitationId])] : []),
    stmt(
      db,
      `INSERT INTO idp_invite_claims (id, org_invitation_id, developer_invitation_id, subject, created_at, claim_until)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      [
        c.id,
        c.kind === 'member' ? c.invitationId : null,
        c.kind === 'developer' ? c.invitationId : null,
        c.subject,
        c.now,
        c.claimUntil,
      ],
    ),
    auditStmt(db, ctx, audit),
  ];
}

/**
 * An existing-account claim: one per invitation and subject (a second click writes nothing), at most three per
 * invitation, never past the invitation's window. A developer invitation's window moves out first, in the same batch.
 */
export async function insertClaim(
  ctx: ServiceContext,
  c: NewClaim,
  audit: AuditEntry,
): Promise<void> {
  await batch(ctx.env.DB, claimStatements(ctx, c, audit));
}

export interface DeveloperAccept {
  invitationId: string;
  orgId: string;
  userId: string;
  subject: string;
  source: GroupSource;
  /** The paired member invitation, which makes the membership in the same batch. */
  memberInvitationId: string | null;
  membershipId: string;
  sponsorId: string;
  now: number;
}

function developerStatements(ctx: ServiceContext, a: DeveloperAccept): D1PreparedStatement[] {
  const db = ctx.env.DB;
  const marked = () =>
    'EXISTS (SELECT 1 FROM developer_invitations g WHERE g.id = ? AND g.accepted_at = ? AND g.accepted_user_id = ?)';
  const mark = [a.invitationId, a.now, a.userId];
  const audit = (
    action: string,
    targetType: string,
    targetId: string,
    detail?: Record<string, unknown>,
  ) =>
    auditStmtWhere(
      db,
      ctx,
      {
        orgId: a.orgId,
        actorType: 'user',
        actorId: a.userId,
        action,
        targetType,
        targetId,
        ...(detail ? { detail } : {}),
      },
      marked(),
      mark,
    );
  return [
    stmt(
      db,
      `UPDATE developer_invitations SET accepted_at = ?, accepted_user_id = ?
       WHERE id = ? AND revoked_at IS NULL AND accepted_at IS NULL AND claim_until > ?
         AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = developer_invitations.org_id AND o.status = 'active'
           AND o.kind = 'standard' AND o.personal_user_id IS NULL)
         AND EXISTS (SELECT 1 FROM users u JOIN user_emails e ON e.user_id = u.id
           WHERE u.id = ? AND u.status = 'active' AND e.email = developer_invitations.email)
         AND (org_invitation_id IS NULL OR EXISTS (SELECT 1 FROM org_invitations m
           WHERE m.id = developer_invitations.org_invitation_id AND m.revoked_at IS NULL AND m.accepted_at IS NULL))
         AND (org_invitation_id IS NULL OR NOT EXISTS (SELECT 1 FROM org_memberships x
           WHERE x.org_id = developer_invitations.org_id AND x.user_id = ? AND x.revoked_at IS NULL))
         AND NOT EXISTS (SELECT 1 FROM developer_sponsors s
           WHERE s.org_id = developer_invitations.org_id AND s.user_id = ? AND s.ended_at IS NULL)
         AND (SELECT CASE json_type(v.value) WHEN 'null' THEN 1
             WHEN 'integer' THEN ((SELECT COUNT(*) FROM developer_sponsors s
                 WHERE s.org_id = developer_invitations.org_id AND s.ended_at IS NULL)
               + (SELECT COUNT(*) FROM developer_invitations d
                 WHERE d.org_id = developer_invitations.org_id AND d.id != developer_invitations.id
                   AND d.revoked_at IS NULL AND d.accepted_at IS NULL AND d.expires_at > ?)) < CAST(v.value AS INTEGER)
             ELSE 0 END
           FROM org_entitlement_values v WHERE v.org_id = developer_invitations.org_id AND v.key = 'members.developers')`,
      [a.now, a.userId, a.invitationId, a.now, a.userId, a.userId, a.userId, a.now],
    ),
    ...(a.memberInvitationId
      ? [
          stmt(
            db,
            `UPDATE org_invitations SET accepted_at = ?
             WHERE id = ? AND revoked_at IS NULL AND accepted_at IS NULL AND EXISTS (SELECT 1 FROM developer_invitations g WHERE g.id = ? AND g.accepted_at = ? AND g.accepted_user_id = ?)`,
            [a.now, a.memberInvitationId, ...mark],
          ),
          stmt(
            db,
            `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
             SELECT ?, i.org_id, ?, i.id, i.roles, ? FROM org_invitations i
             WHERE i.id = ? AND i.accepted_at = ? AND EXISTS (SELECT 1 FROM developer_invitations g WHERE g.id = ? AND g.accepted_at = ? AND g.accepted_user_id = ?)`,
            [a.membershipId, a.userId, a.now, a.memberInvitationId, a.now, ...mark],
          ),
        ]
      : []),
    stmt(
      db,
      `INSERT INTO developer_sponsors (id, org_id, user_id, invitation_id, idp_subject, group_source, created_at)
       SELECT ?, d.org_id, ?, d.id, ?, ?, ? FROM developer_invitations d
       WHERE d.id = ? AND d.accepted_at = ? AND d.accepted_user_id = ?`,
      [a.sponsorId, a.userId, a.subject, a.source, a.now, ...mark],
    ),
    audit('developer_invitation.accept', 'developer_invitation', a.invitationId, {
      path: a.source,
    }),
    ...(a.memberInvitationId
      ? [
          audit('org_invitation.accept', 'org_invitation', a.memberInvitationId),
          audit('org_membership.create', 'org_membership', a.membershipId),
        ]
      : []),
    // json('{') is malformed: the error rolls the whole batch back when the sponsorship (or the membership) is missing.
    a.memberInvitationId
      ? stmt(
          db,
          `SELECT json('{') WHERE NOT EXISTS (SELECT 1 FROM developer_sponsors s WHERE s.id = ? AND s.invitation_id = ?)
             OR NOT EXISTS (SELECT 1 FROM org_memberships m WHERE m.id = ? AND m.invitation_id = ?)`,
          [a.sponsorId, a.invitationId, a.membershipId, a.memberInvitationId],
        )
      : stmt(
          db,
          `SELECT json('{') WHERE NOT EXISTS (SELECT 1 FROM developer_sponsors s WHERE s.id = ? AND s.invitation_id = ?)`,
          [a.sponsorId, a.invitationId],
        ),
  ];
}

/**
 * Accepts a developer invitation: the invitation, its paired member invitation and membership, the sponsorship and
 * the audit rows, in one batch that either all lands or none of it does. The invitation's own update is the gate: it
 * holds the open window, the invited address verified on this user, an active standard org, no live sponsorship or
 * membership already, and room under `members.developers` (counting the others still pending, and the sponsors).
 * Everything after it keys on the gate's own mark, and a last statement stops the batch when any part is missing,
 * so a half-accepted invitation cannot exist. True when it landed.
 */
export async function acceptDeveloper(ctx: ServiceContext, a: DeveloperAccept): Promise<boolean> {
  try {
    await batch(ctx.env.DB, developerStatements(ctx, a));
    return true;
  } catch (error) {
    if (landedNot(error)) return false;
    throw error;
  }
}

export interface MemberAccept {
  invitationId: string;
  orgId: string;
  userId: string;
  membershipId: string;
  now: number;
}

function memberStatements(ctx: ServiceContext, a: MemberAccept): D1PreparedStatement[] {
  const db = ctx.env.DB;
  const made = () =>
    'EXISTS (SELECT 1 FROM org_memberships m WHERE m.id = ? AND m.invitation_id = ? AND m.user_id = ?)';
  const mark = [a.membershipId, a.invitationId, a.userId];
  const audit = (action: string, targetType: string, targetId: string) =>
    auditStmtWhere(
      db,
      ctx,
      { orgId: a.orgId, actorType: 'user', actorId: a.userId, action, targetType, targetId },
      made(),
      mark,
    );
  return [
    stmt(
      db,
      `UPDATE org_invitations SET accepted_at = ?
       WHERE id = ? AND revoked_at IS NULL AND accepted_at IS NULL AND expires_at > ?
         AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = org_invitations.org_id AND o.status = 'active')
         AND EXISTS (SELECT 1 FROM users u JOIN user_emails e ON e.user_id = u.id
           WHERE u.id = ? AND u.status = 'active' AND e.email = org_invitations.email)
         AND NOT EXISTS (SELECT 1 FROM org_memberships x
           WHERE x.org_id = org_invitations.org_id AND x.user_id = ? AND x.revoked_at IS NULL)`,
      [a.now, a.invitationId, a.now, a.userId, a.userId],
    ),
    stmt(
      db,
      `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
       SELECT ?, i.org_id, ?, i.id, i.roles, ? FROM org_invitations i
       WHERE i.id = ? AND i.accepted_at = ?`,
      [a.membershipId, a.userId, a.now, a.invitationId, a.now],
    ),
    audit('org_invitation.accept', 'org_invitation', a.invitationId),
    audit('org_membership.create', 'org_membership', a.membershipId),
    // json('{') is malformed: the error rolls the whole batch back when the membership is missing.
    stmt(db, `SELECT json('{') WHERE NOT ${made()}`, mark),
  ];
}

/**
 * Accepts a member invitation: the invitation's own update is the gate (open, the org active, the invited address
 * verified on this active user, no live membership already), the membership and audit rows key on it, and a last
 * statement stops the batch when the membership is missing, so it lands whole or not at all. The row count of an
 * insert cannot say whether it landed (a trigger's own writes count), so nothing here reads one. True when it landed.
 */
export async function acceptMember(ctx: ServiceContext, a: MemberAccept): Promise<boolean> {
  try {
    await batch(ctx.env.DB, memberStatements(ctx, a));
    return true;
  } catch (error) {
    if (landedNot(error)) return false;
    throw error;
  }
}
