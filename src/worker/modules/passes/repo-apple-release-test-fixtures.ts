import type { Mode } from '../../../shared/contracts/common.ts';
import { batch, first, run, stmt } from '../../platform/db.ts';

export function insertReleaseFixtureUser(db: D1Database, userId: string, now: number) {
  return run(
    db,
    `INSERT INTO users (id, primary_email, created_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
    [userId, `pass-route-${userId}@example.test`, now],
  );
}

export function findReleaseFixtureUser(db: D1Database, userId: string) {
  return first<{ primary_email: string }>(db, 'SELECT primary_email FROM users WHERE id = ?', [
    userId,
  ]);
}

export function findReleaseFixtureMembership(db: D1Database, orgId: string, userId: string) {
  return first<{ id: string; roles: string }>(
    db,
    'SELECT id, roles FROM org_memberships WHERE org_id = ? AND user_id = ? AND revoked_at IS NULL',
    [orgId, userId],
  );
}

export function insertReleaseFixtureMembership(
  db: D1Database,
  input: {
    invitationId: string;
    orgId: string;
    email: string;
    encodedRoles: string;
    tokenHash: string;
    now: number;
    membershipId: string;
    userId: string;
  },
) {
  return batch(db, [
    stmt(
      db,
      `INSERT INTO org_invitations
         (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.invitationId,
        input.orgId,
        input.email,
        input.encodedRoles,
        input.tokenHash,
        input.now,
        input.now + 86_400_000,
        input.now,
      ],
    ),
    stmt(
      db,
      `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        input.membershipId,
        input.orgId,
        input.userId,
        input.invitationId,
        input.encodedRoles,
        input.now,
      ],
    ),
  ]);
}

export function findReleaseFixtureVersion(db: D1Database, templateId: string, version: string) {
  return first<{ manifest: string; pass_json: string; assets: string }>(
    db,
    `SELECT manifest, pass_json, assets FROM template_versions
     WHERE template_id = ? AND version = ?`,
    [templateId, version],
  );
}

export function findAppleReleaseFixtureGeneration(
  db: D1Database,
  templateId: string,
  orgId: string,
  mode: Mode,
) {
  return first<{ generation: number }>(
    db,
    `SELECT COALESCE(MAX(generation), 0) AS generation FROM template_releases
     WHERE template_id = ? AND org_id = ? AND mode = ? AND provider = 'apple'`,
    [templateId, orgId, mode],
  );
}
