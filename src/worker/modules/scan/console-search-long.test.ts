import { beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { kit, request, setupScanningAuthorityFixture } from './scanning-authority-test-fixtures.ts';

beforeAll(setupScanningAuthorityFixture);

// Each name over D1's 50-byte LIKE cap once searched, plus a literal %/_ name and its decoy.
const NAMES = {
  ascii: `${'Harbor '.repeat(9)}Alice`,
  wide: `${'日本'.repeat(19)}Bob`,
  literal: 'Promo 100%_off',
  decoy: 'Promo 100 x off',
};
type Key = keyof typeof NAMES;

async function names(path: string, q: string): Promise<string[]> {
  const response = await request('GET', `${path}?orgId=${kit.org.id}&q=${encodeURIComponent(q)}`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { items: { name: string }[] }).items
    .map((item) => item.name)
    .sort();
}

/** One row per name, renamed in SQL so a stored name can exceed the create limits. */
async function seed(table: 'scan_events' | 'scanners' | 'scan_staff', make: () => Promise<string>) {
  for (const name of Object.values(NAMES))
    await run(kit.env.DB, `UPDATE ${table} SET name=? WHERE id=?`, [name, await make()]);
}

const only = (...keys: Key[]) => keys.map((key) => NAMES[key]).sort();

describe('console name searches at any length', () => {
  it('finds events by a long, multi-byte or literal %/_ prefix', async () => {
    await seed('scan_events', async () => (await kit.event({ templateIds: [] })).id);
    const search = (q: string) => names('/scan-events', q);
    expect(NAMES.ascii.length).toBeGreaterThan(50);
    expect(await search(NAMES.ascii.slice(0, 60))).toEqual(only('ascii'));
    expect(await search(NAMES.ascii.slice(0, 60).toLowerCase())).toEqual(only('ascii'));
    expect(await search(`${NAMES.ascii.slice(0, 59)}X`)).toEqual([]);
    expect(await search(NAMES.wide.slice(0, 20))).toEqual(only('wide'));
    expect(await search(`${NAMES.wide.slice(0, 19)}X`)).toEqual([]);
    expect(await search('Promo 100%_')).toEqual(only('literal'));
    expect(await search('Promo 100')).toEqual(only('literal', 'decoy'));
  });

  it('finds scanners by a long, multi-byte or literal %/_ prefix', async () => {
    await seed('scanners', async () => (await kit.scanner({ templateIds: [] })).id);
    const search = (q: string) => names('/scanners', q);
    expect(await search(NAMES.ascii.slice(0, 60))).toEqual(only('ascii'));
    expect(await search(NAMES.ascii.slice(0, 60).toLowerCase())).toEqual(only('ascii'));
    expect(await search(`${NAMES.ascii.slice(0, 59)}X`)).toEqual([]);
    expect(await search(NAMES.wide.slice(0, 20))).toEqual(only('wide'));
    expect(await search(`${NAMES.wide.slice(0, 19)}X`)).toEqual([]);
    expect(await search('Promo 100%_')).toEqual(only('literal'));
    expect(await search('Promo 100')).toEqual(only('literal', 'decoy'));
  });

  it('finds staff by any long, multi-byte or literal %/_ part of the name', async () => {
    let n = 0;
    await seed('scan_staff', async () => (await kit.staff('door', `Seed ${++n}`)).id);
    const search = (q: string) => names('/scan-staff', q);
    expect(await search(NAMES.ascii.slice(4, 64))).toEqual(only('ascii'));
    expect(await search(NAMES.ascii.slice(4, 64).toUpperCase())).toEqual(only('ascii'));
    expect(await search(`${NAMES.ascii.slice(4, 63)}X`)).toEqual([]);
    expect(await search(NAMES.wide.slice(1, 21))).toEqual(only('wide'));
    expect(await search(`${NAMES.wide.slice(1, 20)}X`)).toEqual([]);
    expect(await search('o 100%_o')).toEqual(only('literal'));
    expect(await search('o 100')).toEqual(only('literal', 'decoy'));
  });
});
