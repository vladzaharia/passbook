import { all, first } from '../../platform/db.ts';

/** What an org holds against each limit, counted the way the limit's own check counts it. */
export type OrgUsage = Record<
  | 'passes.live'
  | 'passes.test'
  | 'templates'
  | 'scanning.devices'
  | 'members'
  | 'api.keys'
  | 'webhooks.endpoints'
  | 'connections',
  number
>;

/** One read, a count per limit key. `now` ends the pending invitations and keys that have expired. */
export async function orgUsage(db: D1Database, orgId: string, now: number): Promise<OrgUsage> {
  const pass = (mode: string) =>
    `(SELECT COUNT(*) FROM passes p WHERE p.org_id = o.id AND p.mode = '${mode}'
      AND p.removed_at IS NULL AND p.deleted_at IS NULL AND p.test_data_quarantined = 0)`;
  const row = await first<Record<string, number>>(
    db,
    `SELECT
       ${pass('live')} AS live,
       ${pass('test')} AS test,
       (SELECT COUNT(*) FROM templates t WHERE t.org_id = o.id AND t.status <> 'deleted') AS templates,
       (SELECT COUNT(*) FROM scanners sc WHERE sc.org_id = o.id AND sc.revoked_at IS NULL) AS scanners,
       (SELECT COUNT(*) FROM org_memberships m WHERE m.org_id = o.id AND m.revoked_at IS NULL)
         + (SELECT COUNT(*) FROM org_invitations i WHERE i.org_id = o.id AND i.revoked_at IS NULL
             AND i.accepted_at IS NULL AND i.expires_at > ?) AS members,
       (SELECT COUNT(*) FROM api_keys k WHERE k.org_id = o.id AND k.revoked_at IS NULL
         AND (k.expires_at IS NULL OR k.expires_at > ?)) AS keys,
       (SELECT COUNT(*) FROM webhook_endpoints we WHERE we.org_id = o.id) AS endpoints,
       (SELECT COUNT(*) FROM connections cn WHERE cn.org_id = o.id) AS connections
     FROM orgs o WHERE o.id = ?`,
    [now, now, orgId],
  );
  const n = (key: string) => row?.[key] ?? 0;
  return {
    'passes.live': n('live'),
    'passes.test': n('test'),
    templates: n('templates'),
    'scanning.devices': n('scanners'),
    members: n('members'),
    'api.keys': n('keys'),
    'webhooks.endpoints': n('endpoints'),
    connections: n('connections'),
  };
}

/** The plan (preset id and label) of each org; an org with no features row is absent. */
export async function plansOf(
  db: D1Database,
  orgIds: string[],
): Promise<Map<string, { preset: string; label: string }>> {
  if (orgIds.length === 0) return new Map();
  const rows = await all<{ org_id: string; preset: string; label: string }>(
    db,
    `SELECT e.org_id, e.preset, m.label FROM org_entitlements e
       JOIN entitlement_preset_meta m ON m.preset = e.preset
      WHERE e.org_id IN (${orgIds.map(() => '?').join(',')})`,
    orgIds,
  );
  return new Map(rows.map((r) => [r.org_id, { preset: r.preset, label: r.label }]));
}
