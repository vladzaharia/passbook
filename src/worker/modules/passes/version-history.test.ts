import { beforeAll, describe, expect, it } from 'vitest';
import { makeUser, withoutTrigger } from '../../../../test/helpers/index.ts';
import { all, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getMyPass } from '../me/repo.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { publishPass } from './publish.ts';
import { getPass } from './repo-read-pass.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});

describe('a publish that stores no artifact', () => {
  it('raises version past the stored ones, and the holder still gets the stored pass.json', async () => {
    const owner = await makeUser(kit.fx);
    const created = await kit.pass();
    // A legacy row without a content hash is re-stamped, not re-published, when its content is unchanged.
    await run(kit.env.DB, 'UPDATE passes SET content_hash = NULL WHERE id = ?', [created.id]);
    const result = await publishPass(jobCtxOf(kit), {
      passId: created.id,
      orgScope: kit.org.id,
      cause: 'admin',
      actor: { type: 'user', id: 'admin-1' },
    });
    expect(result.changed).toBe(false);

    const after = await getPass(kit.env.DB, created.id);
    expect(after?.version).toBe(created.version + 1);
    const stored = await all<{ version: number }>(
      kit.env.DB,
      'SELECT version FROM pass_versions WHERE pass_id = ?',
      [created.id],
    );
    expect(stored.map((row) => row.version)).toEqual([created.version]);

    await withoutTrigger(kit.env.DB, 'pass_credential_transfer_required', () =>
      run(kit.env.DB, 'UPDATE passes SET owner_user_id = ? WHERE id = ?', [owner.id, created.id]),
    );
    const mine = await getMyPass(kit.env.DB, owner.id, created.id);
    expect(mine?.version).toBe(created.version + 1);
    expect(JSON.parse(mine?.pass_json ?? 'null')).toMatchObject({
      description: expect.any(String),
    });
  });
});
