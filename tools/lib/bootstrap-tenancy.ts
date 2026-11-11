// Cutover bootstrap for a database that predates memberships and template releases (schema 0024).
// Pure: turns a snapshot of the database into a plan and an idempotent SQL file. Gives the owner
// org_admin everywhere, a legacy live release to every active uploaded template, and binds pass emails the old Worker queued to their pass, which the new
// Worker needs before it will send them. Baked templates get their system releases from the baked
// sync, never from here.
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
  /** Pass emails queued by the old Worker (`{ to, attach }` payload, no `intent`) that have not been sent. */
  emails?: QueuedEmail[];
}

export interface QueuedEmail {
  outbox_id: string;
  to: string;
  /** SQLite hands a comparison back as 0 or 1. */
  attach: boolean | number;
  pass: {
    id: string;
    org_id: string;
    mode: 'live' | 'test';
    test_data_quarantined: number;
    holder_email: string | null;
    owner_user_id: string | null;
    version: number;
    identity_id: string;
    credential_generation: number;
    lifecycle_generation: number;
    template_id: string;
    template_version: string;
    release_id: string | null;
    web_service_url: string;
    link_generation: number;
    object_key: string;
    /** Only here to be hashed; the tool deletes the snapshot file after reading it. */
    download_token: string;
    status: 'active' | 'voided';
    removed_at: number | null;
  };
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
      WHERE r.template_id = t.id AND r.org_id = s.org_id AND r.mode = 'live' AND r.provider = 'apple')),
  'emails', (SELECT json_group_array(json_object('outbox_id', o.id, 'to', json_extract(o.payload, '$.to'),
      'attach', json_extract(o.payload, '$.attach') = 1, 'pass', json_object('id', p.id, 'org_id', p.org_id,
      'mode', p.mode, 'test_data_quarantined', p.test_data_quarantined, 'holder_email', p.holder_email,
      'owner_user_id', p.owner_user_id, 'version', p.version, 'identity_id', p.identity_id,
      'credential_generation', p.credential_generation, 'lifecycle_generation', p.lifecycle_generation,
      'template_id', p.template_id, 'template_version', p.template_version, 'release_id', p.release_id,
      'web_service_url', p.web_service_url, 'link_generation', p.link_generation, 'object_key', p.object_key,
      'download_token', p.download_token, 'status', p.status, 'removed_at', p.removed_at)))
    FROM outbox o JOIN passes p ON p.id = o.pass_id
    WHERE o.kind = 'email' AND o.state IN ('pending', 'enqueued') AND json_extract(o.payload, '$.intent') IS NULL
      AND json_extract(o.payload, '$.bundleId') IS NULL AND typeof(json_extract(o.payload, '$.to')) = 'text')
) AS snapshot`;

export interface BootstrapResult {
  plan: string[];
  /** One entry per statement, in order. */
  statements: string[];
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
  for (const e of snapshot.emails ?? []) {
    const p = e.pass;
    const intent = {
      format: 1,
      to: e.to,
      attach: e.attach === true || e.attach === 1,
      pass: {
        passId: p.id,
        orgId: p.org_id,
        mode: p.mode,
        testDataQuarantined: p.test_data_quarantined === 1,
        holderEmail: p.holder_email,
        ownerUserId: p.owner_user_id,
        version: p.version,
        identityId: p.identity_id,
        credentialGeneration: p.credential_generation,
        lifecycleGeneration: p.lifecycle_generation,
        templateId: p.template_id,
        templateVersion: p.template_version,
        releaseId: p.release_id,
        webServiceUrl: p.web_service_url,
        linkGeneration: p.link_generation,
        objectKey: p.object_key,
        downloadTokenHash: await sha256Hex(p.download_token),
        status: p.status,
        removedAt: p.removed_at,
      },
    };
    plan.push(`email ${e.outbox_id}: bind the queued pass email to pass ${p.id}`);
    // Runs only while the pass still is the one the snapshot saw; a changed pass leaves the row unbound,
    // and delivery cancels it as DELIVERY_UNBOUND.
    sql.push(`UPDATE outbox SET payload = json_set(payload, '$.intent', json(${q(JSON.stringify(intent))}))
  WHERE id = ${q(e.outbox_id)} AND kind = 'email' AND state IN ('pending', 'enqueued')
    AND json_extract(payload, '$.intent') IS NULL
    AND EXISTS (SELECT 1 FROM passes p WHERE p.id = ${q(p.id)} AND p.version = ${p.version}
      AND p.credential_generation = ${p.credential_generation} AND p.link_generation = ${p.link_generation}
      AND p.lifecycle_generation = ${p.lifecycle_generation} AND p.download_token = ${q(p.download_token)});`);
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
  return { plan, statements: sql.slice(1), sql: `${sql.join('\n')}\n` };
}
