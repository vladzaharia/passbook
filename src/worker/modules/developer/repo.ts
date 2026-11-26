import { all, first } from '../../platform/db.ts';

export interface SandboxRow {
  id: string;
  org_id: string;
  slug: string;
  created_at: number;
  closed_at: number | null;
  /** The org's `org.timeZone` setting as stored (JSON), null when unset. */
  time_zone: string | null;
}

const SELECT = `SELECT d.id, d.org_id, o.slug, d.created_at, d.closed_at,
  (SELECT s.value FROM settings s WHERE s.scope = 'org:' || d.org_id AND s.key = 'org.timeZone') AS time_zone
  FROM developer_sandboxes d JOIN orgs o ON o.id = d.org_id`;

export const sandboxOfUser = (db: D1Database, userId: string) =>
  first<SandboxRow>(db, `${SELECT} WHERE d.user_id = ?`, [userId]);

/** The user's primary address, which the sandbox's membership invitation names. */
export const primaryEmailOf = async (db: D1Database, userId: string): Promise<string | null> =>
  (
    await first<{ primary_email: string }>(db, 'SELECT primary_email FROM users WHERE id = ?', [
      userId,
    ])
  )?.primary_email ?? null;

/**
 * Open sandboxes with no activity since `cutoff`. Activity is the last use of a key, the last pass made or the
 * last audited action in the org; a sandbox that never did any is idle from its creation.
 */
export const idleSandboxOrgs = async (
  db: D1Database,
  cutoff: number,
  limit: number,
): Promise<string[]> =>
  (
    await all<{ org_id: string }>(
      db,
      `SELECT d.org_id FROM developer_sandboxes d JOIN orgs o ON o.id = d.org_id AND o.status = 'active'
       WHERE d.closed_at IS NULL AND d.created_at < ?1
         AND COALESCE((SELECT MAX(k.last_used_at) FROM api_keys k WHERE k.org_id = d.org_id), 0) < ?1
         AND COALESCE((SELECT MAX(p.created_at) FROM passes p WHERE p.org_id = d.org_id), 0) < ?1
         AND COALESCE((SELECT MAX(a.at) FROM audit_log a WHERE a.org_id = d.org_id), 0) < ?1
       ORDER BY d.created_at LIMIT ?2`,
      [cutoff, limit],
    )
  ).map((r) => r.org_id);

/** The quickstart ticket of a sandbox org, when it was made. */
export const quickstartTemplateOf = async (db: D1Database, orgId: string, name: string) =>
  (
    await first<{ id: string }>(db, 'SELECT id FROM templates WHERE org_id = ? AND name = ?', [
      orgId,
      name,
    ])
  )?.id ?? null;

/** The sandbox's ticket template and the version it opens from. */
export const ticketOf = (db: D1Database, orgId: string, name: string) =>
  first<{ id: string; version: string | null }>(
    db,
    `SELECT t.id, COALESCE(t.active_version, (SELECT v.version FROM template_versions v WHERE v.template_id = t.id ORDER BY v.rowid LIMIT 1)) AS version
     FROM templates t WHERE t.org_id = ? AND t.name = ?`,
    [orgId, name],
  );

export const hasTestRelease = async (db: D1Database, templateId: string, orgId: string) =>
  (await first<{ n: number }>(
    db,
    `SELECT 1 AS n FROM template_releases WHERE template_id = ? AND org_id = ? AND mode = 'test' AND provider = 'apple' LIMIT 1`,
    [templateId, orgId],
  )) !== null;

export const candidateOf = (db: D1Database, templateId: string, orgId: string, version: string) =>
  first<{ id: string; candidate_hash: string }>(
    db,
    `SELECT id, candidate_hash FROM template_candidates
     WHERE template_id = ? AND org_id = ? AND mode = 'test' AND provider = 'apple' AND version = ?
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    [templateId, orgId, version],
  );

export const approvalOf = async (db: D1Database, candidateId: string) =>
  (
    await first<{ id: string }>(
      db,
      'SELECT id FROM template_approvals WHERE candidate_id = ? LIMIT 1',
      [candidateId],
    )
  )?.id ?? null;

/** The key the sandbox made for its person, revoked or not: it is minted once. */
export const sandboxKeyOf = (db: D1Database, orgId: string, userId: string, name: string) =>
  first<{ id: string; name: string }>(
    db,
    `SELECT id, name FROM api_keys WHERE org_id = ? AND created_by = ? AND name = ? AND kind = 'personal' ORDER BY created_at LIMIT 1`,
    [orgId, userId, name],
  );
