import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth, TEST_NOW } from '../../../../test/helpers/index.ts';
import { ScanRosterSchema } from '../../../shared/contracts/scan-session.ts';
import { ROSTER_MAX_ENTRIES } from '../../../shared/scan-offline.ts';
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

const paperOn = (passId: string, on: boolean) =>
  call('PUT', `/passes/${passId}/channels`, { channels: { paper: on ? 'on' : 'off' } });
const printed = async () => {
  const pass = await kit.scanPass(tpl);
  await paperOn(pass.id, true);
  return pass;
};
const quiet = (passId: string) =>
  run(kit.env.DB, 'UPDATE passes SET modified_at = 1 WHERE id = ?', [passId]);

describe('the offline roster delta and prints', () => {
  it('sees a reprint and a void after `since`, and groups the pass codes', async () => {
    kit.clock.set(TEST_NOW);
    const door = await kit.scanner({ templateIds: [tpl], settings: LIST });
    const pass = await printed();
    const first = await mint(pass.id);
    const since = TEST_NOW + 60_000;
    kit.clock.set(since + 1000);
    // Only the print moves: the pass's own change time stays before `since`.
    await quiet(pass.id);
    const second = await mint(pass.id);
    await quiet(pass.id);

    const body = await deltaOf(door, since);
    const by = new Map(body.entries.map((e) => [e.h, e] as const));
    expect(by.get(await hashOf(first.code))).toMatchObject({ status: 'voided' });
    expect(by.get(await hashOf(first.code))?.g).toBeUndefined();
    const phone = by.get(await hashOf(pass.scanCode ?? ''));
    const paper = by.get(await hashOf(second.code));
    expect(paper).toMatchObject({ status: 'active' });
    expect(phone?.g).toMatch(/^[0-9]+$/);
    expect(phone?.g).toBe(paper?.g);
    expect(ScanRosterSchema.safeParse(body).success).toBe(true);

    kit.clock.set(since + 120_000);
    const later = since + 100_000;
    await call('POST', `/passes/${pass.id}/prints/${second.id}/void`);
    await quiet(pass.id);
    const after = new Map((await deltaOf(door, later)).entries.map((e) => [e.h, e] as const));
    expect(after.get(await hashOf(second.code))).toMatchObject({ status: 'voided' });
  });

  it('puts no group key on a pass with one hash', async () => {
    kit.clock.set(TEST_NOW);
    const door = await kit.scanner({ templateIds: [tpl], settings: LIST });
    const pass = await kit.scanPass(tpl);
    const by = new Map((await deltaOf(door, 0)).entries.map((e) => [e.h, e] as const));
    const own = by.get(await hashOf(pass.scanCode ?? ''));
    expect(own).toBeDefined();
    expect(own?.g).toBeUndefined();
  });

  it('leaves the print off while paper is not effectively on', async () => {
    kit.clock.set(TEST_NOW);
    const door = await kit.scanner({ templateIds: [tpl], settings: LIST });
    const pass = await printed();
    const p = await mint(pass.id);
    const h = await hashOf(p.code);
    const has = async () =>
      ((await (await kit.get(door.headers, '/roster')).json()) as RosterBody).entries.some(
        (e) => e.h === h,
      );
    expect(await has()).toBe(true);
    expect((await paperOn(pass.id, false)).status).toBe(200);
    expect(await has()).toBe(false);
  });

  it('does not count prints that ended toward the size cap', async () => {
    kit.clock.set(TEST_NOW);
    const door = await kit.scanner({ templateIds: [tpl], settings: LIST });
    const pass = await printed();
    await mint(pass.id);
    const since = TEST_NOW + 1_000_000;
    kit.clock.set(since + 1000);
    await mint(pass.id);
    await quiet(pass.id);
    // Two live entries on this page plus the cursor's count reach the cap exactly; the voided print adds none.
    const res = await kit.get(
      door.headers,
      `/roster?since=${since}&cursor=.${ROSTER_MAX_ENTRIES - 2}`,
    );
    expect(res.status).toBe(200);
  });

  it('drops an active print on a delta when paper goes off without voiding it', async () => {
    kit.clock.set(TEST_NOW);
    const door = await kit.scanner({ templateIds: [tpl], settings: LIST });
    const pass = await printed();
    const p = await mint(pass.id);
    const since = TEST_NOW + 2_000_000;
    kit.clock.set(since + 1000);
    await quiet(pass.id);
    // Paper goes off for the pass; the print itself stays active.
    await run(
      kit.env.DB,
      "UPDATE pass_channels SET override = 'off', set_at = ? WHERE pass_id = ? AND channel = 'paper'",
      [since + 1000, pass.id],
    );
    const by = new Map((await deltaOf(door, since)).entries.map((e) => [e.h, e] as const));
    expect(by.get(await hashOf(p.code))).toMatchObject({ status: 'voided' });
  });
});
