// Cutover bootstrap for a database that predates memberships and template releases (schema 0024).
// Pure: turns a snapshot of the database into a plan and an idempotent SQL file.
import { sha256Hex, uuidv7 } from '../../src/worker/platform/ids.ts';

export interface BootstrapSnapshot {
  owner: { id: string; primary_email: string } | null;
  orgs: { id: string; slug: string }[];
  /** Active uploaded templates paired with each org that uses them, without a live release yet. */
  templates: {
    id: string;
    org_id: string;
    active_version: string;
    manifest: string;
    pass_json: string;
    assets: string;
  }[];
}

const q = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** One row, one column: the snapshot as JSON. Run it with wrangler d1 execute --json. */
export const snapshotSql = (ownerEmail: string) => `SELECT json_object(
  'owner', (SELECT json_object('id', id, 'primary_email', primary_email) FROM users WHERE primary_email = ${q(ownerEmail)}),
  'orgs', (SELECT json_group_array(json_object('id', id, 'slug', slug)) FROM orgs
    WHERE status != 'deleted' AND NOT EXISTS (SELECT 1 FROM org_memberships m JOIN users u ON u.id = m.user_id
      WHERE m.org_id = orgs.id AND m.revoked_at IS NULL AND u.primary_email = ${q(ownerEmail)})),
  'templates', (SELECT json_group_array(json_object('id', t.id, 'org_id', s.org_id, 'active_version', t.active_version,
      'manifest', v.manifest, 'pass_json', v.pass_json, 'assets', v.assets))
    FROM templates t
    JOIN template_versions v ON v.template_id = t.id AND v.version = t.active_version
    JOIN (SELECT id AS template_id, org_id FROM templates WHERE org_id IS NOT NULL
      UNION SELECT DISTINCT template_id, org_id FROM passes) s ON s.template_id = t.id
    JOIN orgs o ON o.id = s.org_id AND o.status != 'deleted'
    WHERE t.origin = 'uploaded' AND t.status = 'active' AND NOT EXISTS (SELECT 1 FROM template_releases r
      WHERE r.template_id = t.id AND r.org_id = s.org_id AND r.mode = 'live' AND r.provider = 'apple'))
) AS snapshot`;

export interface BootstrapResult {
  plan: string[];
  sql: string;
}

export async function buildBootstrap(
  snapshot: BootstrapSnapshot,
  ownerEmail: string,
  now: number,
): Promise<BootstrapResult> {
  const owner = snapshot.owner;
  if (!owner) throw new Error(`No user ${ownerEmail}. Sign in once as that user, then re-run.`);
  const plan: string[] = [];
  const sql: string[] = [`-- tools/bootstrap-tenancy.ts for ${ownerEmail}. Safe to re-run.`];
  // Only for rows this run inserted, so a re-run adds nothing.
  const audit = (orgId: string, action: string, type: string, table: string, id: string) =>
    `INSERT INTO audit_log (at, org_id, actor_type, actor_id, action, target_type, target_id, detail)
  SELECT ${now}, ${q(orgId)}, 'system', ${q(owner.id)}, ${q(action)}, ${q(type)}, ${q(id)}, ${q(
    JSON.stringify({ tool: 'bootstrap-tenancy', owner: ownerEmail }),
  )} WHERE EXISTS (SELECT 1 FROM ${table} WHERE id = ${q(id)} AND created_at = ${now});`;
  for (const org of snapshot.orgs) {
    const invitation = uuidv7(now);
    const membership = uuidv7(now);
    const token = await sha256Hex(crypto.getRandomValues(new Uint8Array(32)));
    const absent = `NOT EXISTS (SELECT 1 FROM org_memberships m WHERE m.org_id = ${q(org.id)}
    AND m.user_id = ${q(owner.id)} AND m.revoked_at IS NULL)`;
    plan.push(`org ${org.slug}: accepted invitation and org_admin membership for ${ownerEmail}`);
    sql.push(
      `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
  SELECT ${q(invitation)}, ${q(org.id)}, ${q(owner.primary_email)}, '["org_admin"]', ${q(token)}, ${now}, ${now}, ${now}
  WHERE ${absent};`,
      `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
  SELECT ${q(membership)}, ${q(org.id)}, ${q(owner.id)}, ${q(invitation)}, '["org_admin"]', ${now}
  WHERE EXISTS (SELECT 1 FROM org_invitations i WHERE i.id = ${q(invitation)});`,
      audit(org.id, 'org_membership.bootstrap', 'org_membership', 'org_memberships', membership),
    );
  }
  for (const t of snapshot.templates) {
    const release = uuidv7(now);
    // Hashes cover the stored version rows. Legacy releases were never reviewed, so these are
    // provenance markers, not approval digests.
    const content = await sha256Hex(`${t.manifest}\n${t.pass_json}\n${t.assets}`);
    const candidate = await sha256Hex(
      `legacy\n${t.id}\n${t.org_id}\nlive\napple\n${t.active_version}\n${content}`,
    );
    plan.push(`template ${t.id} (${t.org_id}) live: legacy release at version ${t.active_version}`);
    sql.push(
      `INSERT INTO template_releases (id, template_id, org_id, mode, provider, generation, version, candidate_hash,
  content_hash, adapter_revision, adapter_capabilities, audience_policy_revision, source, action, created_by, created_at)
  SELECT ${q(release)}, t.id, ${q(t.org_id)}, 'live', 'apple', 1, t.active_version, ${q(candidate)}, ${q(content)},
    1, '["apple-passkit"]', 1, 'legacy', 'legacy', ${q(owner.id)}, ${now}
  FROM templates t WHERE t.id = ${q(t.id)} AND t.active_version = ${q(t.active_version)}
    AND NOT EXISTS (SELECT 1 FROM template_releases r WHERE r.template_id = t.id
      AND r.org_id = ${q(t.org_id)} AND r.mode = 'live' AND r.provider = 'apple');`,
      audit(
        t.org_id,
        'template_release.bootstrap',
        'template_release',
        'template_releases',
        release,
      ),
    );
  }
  return { plan, sql: `${sql.join('\n')}\n` };
}
