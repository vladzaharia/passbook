import { makeOrg } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { clearSettingsCache } from '../settings/service.ts';
import type { Api } from '../webhooks/api-test-fixtures.ts';

/** An active template with one version; `manifest` may carry `channels` defaults or a wallets block. */
export async function seedTemplate(
  api: Api,
  orgId: string,
  id: string,
  options: { manifest?: object; assets?: object[]; policy?: Record<string, string> } = {},
) {
  const db = api.rig.db;
  const now = api.rig.kit.clock.now();
  await run(
    db,
    `INSERT INTO templates (id, org_id, slug, name, origin, active_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'uploaded', 'v1', ?, ?)`,
    [id, orgId, id, `Template ${id}`, now, now],
  );
  await run(
    db,
    `INSERT INTO template_versions (template_id, version, manifest, pass_json, assets, build_key, created_at)
     VALUES (?, 'v1', ?, '{}', ?, ?, ?)`,
    [
      id,
      JSON.stringify(options.manifest ?? {}),
      JSON.stringify(options.assets ?? []),
      `k/${id}`,
      now,
    ],
  );
  if (options.policy)
    await run(
      db,
      `INSERT INTO template_channel_policies (org_id, mode, template_id, channels, revision, updated_by, updated_at)
       VALUES (?, 'live', ?, ?, 1, 'test', ?)`,
      [orgId, id, JSON.stringify(options.policy), now],
    );
}

export async function setSetting(api: Api, scope: string, key: string, value: unknown) {
  await run(
    api.rig.db,
    'INSERT OR REPLACE INTO settings (scope, key, value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)',
    [scope, key, JSON.stringify(value), 'test', 1],
  );
  clearSettingsCache(api.rig.db);
}

export async function orgWith(api: Api, preset: string) {
  return (await makeOrg(api.rig.kit.fx, { preset })).id;
}
