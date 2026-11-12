import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { makeEnv } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { listAuditRows } from './repo.ts';

describe('audit action filters at any length', () => {
  it('matches and excludes long, multi-byte and literal %/_ prefixes', async () => {
    await makeEnv();
    const actions = [
      `${'long.action.segment.'.repeat(3)}created`,
      `${'long.action.segment.'.repeat(3)}deleted`,
      `${'é日.action.'.repeat(8)}done`,
      'promo.100%_off',
      'promo.100xxoff',
    ];
    for (const action of actions)
      await run(
        env.DB,
        "INSERT INTO audit_log (at, actor_type, action, org_id) VALUES (1, 'system', ?, 'org-long-search')",
        [action],
      );
    const list = async (filter: { action?: string; excludeAction?: string }) =>
      (await listAuditRows(env.DB, { orgId: 'org-long-search', ...filter }, 50))
        .map((r) => r.action)
        .sort();
    expect(actions[0]?.length).toBeGreaterThan(50);
    expect(await list({ action: (actions[0] as string).slice(0, 58) })).toEqual([
      actions[0],
      actions[1],
    ]);
    expect(await list({ action: actions[0] as string })).toEqual([actions[0]]);
    expect(await list({ action: (actions[2] as string).slice(0, 50) })).toEqual([actions[2]]);
    expect(await list({ action: 'promo.100%_' })).toEqual([actions[3]]);
    expect(await list({ excludeAction: (actions[0] as string).slice(0, 58) })).toEqual(
      [actions[2], actions[3], actions[4]].sort(),
    );
    expect(await list({ excludeAction: actions[2] as string })).toEqual(
      [actions[0], actions[1], actions[3], actions[4]].sort(),
    );
    expect(await list({ excludeAction: 'promo.100%_' })).toEqual(
      [actions[0], actions[1], actions[2], actions[4]].sort(),
    );
  });
});
