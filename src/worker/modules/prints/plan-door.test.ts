// MT4a review M3: a downgrade keeps what holders already have. A printed ticket still admits and still
// shows; only a new print is refused.
import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth } from '../../../../test/helpers/index.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { createApp } from '../../app.ts';
import { run } from '../../platform/db.ts';
import { seedBundlePrincipal } from '../bundles/test-auth-fixtures.ts';
import { key, ORIGIN, type ScanKit, setupScanKit } from '../scan/test-kit.ts';
import { clearSettingsCache } from '../settings/service.ts';

let kit: ScanKit;
let tpl: string;
let headers: Record<string, string>;
let app: ReturnType<typeof createApp>;
const json = { 'content-type': 'application/json' };

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
      headers: { ...headers, ...json },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    kit.env,
  );
const print = (value: 0 | 1) =>
  run(
    kit.env.DB,
    `INSERT OR REPLACE INTO org_entitlement_overrides (org_id, key, value, updated_at)
     VALUES (?, 'print', ?, 1)`,
    [kit.org.id, JSON.stringify(value)],
  );
const resolve = async (s: { headers: Record<string, string> }, code: string) =>
  (await (
    await kit.post(s.headers, '/resolve', {
      idempotencyKey: key(),
      input: { code, method: 'camera' },
      clientTs: kit.clock.now(),
    })
  ).json()) as ScanOutcome;

describe('a printed ticket after the plan drops print', () => {
  it('still admits at the door and still shows on its page, while a new print is refused', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl, {}, { holderEmail: 'holder@example.com' });
    expect(
      (await call('PUT', `/passes/${pass.id}/channels`, { channels: { paper: 'on' } })).status,
    ).toBe(200);
    const minted = (await (await call('POST', `/passes/${pass.id}/prints`)).json()) as {
      id: string;
      code: string;
    };
    expect((await resolve(s, minted.code)).kind).not.toBe('refused');

    await print(0);
    // The door: the existing ticket and the pass's own code both admit.
    const at = await resolve(s, minted.code);
    expect(at.kind).not.toBe('refused');
    expect(at.card).not.toBeNull();
    expect((await resolve(s, pass.scanCode ?? '')).kind).not.toBe('refused');
    // New prints and reprints are refused; the ticket is still listed, active and voidable.
    const again = await call('POST', `/passes/${pass.id}/prints`);
    expect(again.status).toBe(403);
    expect(await again.json()).toMatchObject({ code: 'FEATURE_NOT_INCLUDED', feature: 'print' });
    const list = (await (await call('GET', `/passes/${pass.id}/prints`)).json()) as {
      prints: { id: string; status: string }[];
    };
    expect(list.prints).toEqual([expect.objectContaining({ id: minted.id, status: 'active' })]);
  });

  it('a ticket the platform or template turned off is still refused: only the plan is set aside', async () => {
    await print(1);
    const s = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl, {}, { holderEmail: 'holder2@example.com' });
    await call('PUT', `/passes/${pass.id}/channels`, { channels: { paper: 'on' } });
    const minted = (await (await call('POST', `/passes/${pass.id}/prints`)).json()) as {
      code: string;
    };
    await print(0);
    await run(
      kit.env.DB,
      "INSERT OR REPLACE INTO settings (scope, key, value, updated_by, updated_at) VALUES ('platform', 'print.enabled', 'false', 'test', 1)",
    );
    clearSettingsCache(kit.env.DB);
    expect(await resolve(s, minted.code)).toMatchObject({
      kind: 'refused',
      reason: 'channel_off',
      channel: 'paper',
    });
  });
});
