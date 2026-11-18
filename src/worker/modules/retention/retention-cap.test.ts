import { beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { updateSettings } from '../settings/service.ts';
import { type RetentionKit, retentionKit } from './retention-test-fixtures.ts';

let rk: RetentionKit;
beforeAll(async () => {
  rk = await retentionKit();
});

describe('floor cap', () => {
  it('L2: a platform maximum drop that would floor more than 400 orgs is refused whole', async () => {
    const { DB } = rk.kit.env;
    const ids = Array.from({ length: 401 }, () => rk.kit.fx.ids.id());
    for (let i = 0; i < ids.length; i += 100) {
      const part = ids.slice(i, i + 100);
      await DB.batch([
        ...part.map((id) =>
          DB.prepare(
            'INSERT INTO orgs (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, 1, 1)',
          ).bind(id, `cap-${id.slice(-8)}`, 'Cap'),
        ),
        ...part.map((id) =>
          DB.prepare(
            "INSERT INTO settings (scope, key, value, updated_at) VALUES (?, 'retention.scansDays', '1000', 1)",
          ).bind(`org:${id}`),
        ),
      ]);
    }
    const admin = await rk.platform();
    const save = updateSettings(
      rk.kit.ctx,
      { type: 'user', id: admin.userId },
      { scope: 'platform', values: { 'retention.scansMaxDays': 500 } },
      undefined,
      admin,
    );
    await expect(save).rejects.toMatchObject({ status: 422, code: 'RETENTION_TOO_MANY_ORGS' });
    expect((await run(DB, 'SELECT 1 FROM retention_floors WHERE 0')).changes).toBe(0);
  });
});
