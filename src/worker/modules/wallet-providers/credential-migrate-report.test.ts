// WA1d: the report pages by cursor, so no pending account is out of sight.
import { beforeAll, describe, expect, it } from 'vitest';
import { migrationReport } from './credential-migrate.ts';
import { seedLegacy } from './credential-migrate-test-fixtures.ts';
import { type Kit, kit } from './wallet-wa1b-test-fixtures.ts';

let k: Kit;
beforeAll(async () => {
  k = await kit();
}, 30_000);

describe('migration report paging', () => {
  it('walks 150 pending accounts in two pages with exact counts', async () => {
    const admin = await k.admin();
    const ids: string[] = [];
    for (let i = 0; i < 150; i++)
      ids.push((await seedLegacy(k, (await k.org()).id, 'test', 'google', k.google(`9${i}`))).id);
    const one = await migrationReport(k.ctx, admin.auth);
    expect(one.pending).toBe(150);
    expect(one.items).toHaveLength(100);
    expect(one.next).toBe(one.items[99]?.accountId);
    const two = await migrationReport(k.ctx, admin.auth, one.next ?? '');
    expect(two.items).toHaveLength(50);
    expect(two.next).toBeNull();
    const seen = [...one.items, ...two.items].map((i) => i.accountId);
    expect(new Set(seen)).toEqual(new Set(ids));
    expect(seen).toHaveLength(150);
  }, 120_000);
});
