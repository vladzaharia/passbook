import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth, TEST_NOW } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { run } from '../../platform/db.ts';
import { seedBundlePrincipal } from '../bundles/test-auth-fixtures.ts';
import { hashOf, LIST, type RosterBody } from '../scan/offline-test-fixtures.ts';
import { ORIGIN, type ScanKit, setupScanKit } from '../scan/test-kit.ts';
import { clearSettingsCache } from '../settings/service.ts';

let kit: ScanKit;
let tpl: string;
let headers: Record<string, string>;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  kit = await setupScanKit();
  tpl = await kit.scanTemplate('Tickets', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
  const fake = fakeAuth(ORIGIN);
  app = createApp({ stores: fake.stores, clock: kit.clock });
  headers = fake.admin();
  await seedBundlePrincipal(kit, fake, headers);
  await run(
    kit.env.DB,
    "INSERT OR REPLACE INTO settings (scope, key, value, updated_by, updated_at) VALUES ('platform', 'print.enabled', 'true', 'test', 1)",
  );
  clearSettingsCache(kit.env.DB);
});

const call = (method: string, path: string, body?: unknown) =>
  app.request(
    `${ORIGIN}/api/v1${path}`,
    {
      method,
      headers: { ...headers, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    kit.env,
  );
const mint = async (passId: string) =>
  (await (await call('POST', `/passes/${passId}/prints`)).json()) as { id: string; code: string };
const deltaOf = async (door: { headers: Record<string, string> }, since: number) =>
  (await (await kit.get(door.headers, `/roster?since=${since}`)).json()) as RosterBody;

describe('the offline roster delta and prints', () => {
  it('sees a reprint and a void after `since`, and groups the pass codes', async () => {
    kit.clock.set(TEST_NOW);
    const door = await kit.scanner({ templateIds: [tpl], settings: LIST });
    const pass = await kit.scanPass(tpl);
    await call('PUT', `/passes/${pass.id}/channels`, { channels: { paper: 'on' } });
    const first = await mint(pass.id);
    const since = TEST_NOW + 60_000;
    kit.clock.set(since + 1000);
    // Pin the pass out of the delta by its own change time: only the print moved.
    await run(kit.env.DB, 'UPDATE passes SET modified_at = 1 WHERE id = ?', [pass.id]);
    const second = await mint(pass.id);
    await run(kit.env.DB, 'UPDATE passes SET modified_at = 1 WHERE id = ?', [pass.id]);

    const by = new Map((await deltaOf(door, since)).entries.map((e) => [e.h, e] as const));
    expect(by.get(await hashOf(first.code))).toMatchObject({ status: 'voided' });
    expect(by.get(await hashOf(second.code))).toMatchObject({ status: 'active' });
    const phone = by.get(await hashOf(pass.scanCode ?? ''));
    const paper = by.get(await hashOf(second.code));
    expect(phone?.g).toBeTruthy();
    expect(phone?.g).toBe(paper?.g);

    kit.clock.set(since + 120_000);
    const later = since + 100_000;
    await call('POST', `/passes/${pass.id}/prints/${second.id}/void`);
    await run(kit.env.DB, 'UPDATE passes SET modified_at = 1 WHERE id = ?', [pass.id]);
    const after = new Map((await deltaOf(door, later)).entries.map((e) => [e.h, e] as const));
    expect(after.get(await hashOf(second.code))).toMatchObject({ status: 'voided' });
  });
});
