import { beforeAll, expect, it } from 'vitest';
import { fakeAuth } from '../../../../test/helpers/index.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { createApp } from '../../app.ts';
import { first, run } from '../../platform/db.ts';
import { seedBundlePrincipal } from '../bundles/test-auth-fixtures.ts';
import { clearSettingsCache } from '../settings/service.ts';
import { admitsJson } from './admits.ts';
import { key, ORIGIN, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let app: ReturnType<typeof createApp>;
let admin: Record<string, string>;
const CHECK_IN = { id: 'check_in', label: 'Check in', kind: 'check_in' } as const;

beforeAll(async () => {
  kit = await setupScanKit();
  const fake = fakeAuth(ORIGIN);
  app = createApp({ stores: fake.stores, clock: kit.clock });
  admin = fake.admin();
  await seedBundlePrincipal(kit, fake, admin);
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
      headers: { ...admin, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    kit.env,
  );

async function mixedDoor(templateIds: string[], eventIds: string[]) {
  const scanner = await kit.scanner({ templateIds });
  const sessionId = kit.fx.ids.id();
  await run(
    kit.env.DB,
    `INSERT INTO scanning_sessions (id,org_id,mode,name,status,accepts,settings,time_zone,created_at,updated_at)
     SELECT ?,org_id,mode,name,'active',?,settings,time_zone,created_at,updated_at FROM scanners WHERE id=?`,
    [sessionId, admitsJson({ templateIds, eventIds }), scanner.id],
  );
  await run(
    kit.env.DB,
    `INSERT INTO scanning_devices (scanner_id,session_id,org_id,mode,surface,effective_surface,overrides)
     SELECT id,?,org_id,mode,'phone','phone','{}' FROM scanners WHERE id=?`,
    [sessionId, scanner.id],
  );
  return scanner.headers;
}

it('keeps the print door rules for a pass admitted through an event', async () => {
  const ticket = await kit.scanTemplate('Channel ticket', { actions: [CHECK_IN] });
  const entry = await kit.scanTemplate('Channel entry', { actions: [CHECK_IN] });
  const event = await kit.event({ templateIds: [ticket] });
  const headers = await mixedDoor([entry], [event.id]);
  const pass = await kit.scanPass(ticket);
  expect(
    (await call('PUT', `/passes/${pass.id}/channels`, { channels: { paper: 'on' } })).status,
  ).toBe(200);
  const mint = async () =>
    (await (await call('POST', `/passes/${pass.id}/prints`)).json()) as { code: string };
  const act = async (code: string) =>
    (await (
      await kit.post(headers, '/actions', {
        idempotencyKey: key(),
        input: { code, method: 'camera' },
        clientTs: kit.clock.now(),
        actionId: 'auto',
      })
    ).json()) as ScanOutcome;
  const replaced = await mint();
  const current = await mint();
  expect(await act(replaced.code)).toMatchObject({ kind: 'refused', reason: 'print_replaced' });
  const admitted = await act(current.code);
  expect(admitted).toMatchObject({ kind: 'ok' });
  expect(
    await first(kit.env.DB, 'SELECT event_id FROM scans WHERE id=?', [admitted.scanId]),
  ).toEqual({ event_id: event.id });
  expect(
    (await call('PUT', `/passes/${pass.id}/channels`, { channels: { paper: 'off' } })).status,
  ).toBe(200);
  expect(await act(current.code)).toMatchObject({ kind: 'refused', reason: 'print_voided' });
});
