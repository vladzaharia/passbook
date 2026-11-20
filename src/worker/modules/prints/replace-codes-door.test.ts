import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth } from '../../../../test/helpers/index.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { CHANNEL_COPY } from '../../../shared/copy/channels.ts';
import { createApp } from '../../app.ts';
import { all, run } from '../../platform/db.ts';
import { seedBundlePrincipal } from '../bundles/test-auth-fixtures.ts';
import { rotateCode } from '../channels/replace.ts';
import { mayPublish } from '../channels/repo-replace.ts';
import { codesReplacedNotice } from '../channels/service.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { newPassCode } from '../passes/new-code.ts';
import { getPass } from '../passes/repo-read-pass.ts';
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
const resolve = async (s: { headers: Record<string, string> }, code: string, method = 'camera') =>
  (await (
    await kit.post(s.headers, '/resolve', {
      idempotencyKey: key(),
      input: { code, method },
      clientTs: kit.clock.now(),
    })
  ).json()) as ScanOutcome;
const printable = async () => {
  const pass = await kit.scanPass(tpl);
  await call('PUT', `/passes/${pass.id}/channels`, { channels: { paper: 'on' } });
  return pass;
};
const status = (passId: string) =>
  all<{ status: string; void_cause: string | null }>(
    kit.env.DB,
    'SELECT status, void_cause FROM pass_prints WHERE pass_id = ?',
    [passId],
  );

describe('after replace codes', () => {
  it('answers code_replaced for the old code, admits the new one, and checks a typed number', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const pass = await printable();
    await call('PUT', `/passes/${pass.id}/channels`, { channels: { apple: 'off' } });
    const old = pass.scanCode ?? '';
    expect((await resolve(s, old)).kind).not.toBe('refused');
    expect(await rotateCode(jobCtxOf({ ctx: kit.ctx }), pass.id, 'channel_apply:run-1')).toBe(
      'rotated',
    );
    expect(await resolve(s, old)).toMatchObject({ kind: 'refused', reason: 'code_replaced' });
    const fresh = (await getPass(kit.env.DB, pass.id))?.scanCode ?? '';
    expect(fresh).not.toBe(old);
    expect((await resolve(s, fresh)).kind).not.toBe('refused');
    // A serial typed in by hand can no longer be told from a copy of the old code: it is checked.
    expect(await resolve(s, pass.serial, 'manual')).toMatchObject({
      kind: 'heads_up',
      reason: 'check_required',
    });
  });

  it('keeps the active print, and its code still admits; a manual New code still voids it', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const pass = await printable();
    const minted = (await (await call('POST', `/passes/${pass.id}/prints`)).json()) as {
      code: string;
    };
    await rotateCode(jobCtxOf({ ctx: kit.ctx }), pass.id, `channel_bulk:b-${pass.id}`);
    expect(await status(pass.id)).toEqual([{ status: 'active', void_cause: null }]);
    expect((await resolve(s, minted.code)).kind).not.toBe('refused');
    await newPassCode(jobCtxOf({ ctx: kit.ctx }), { type: 'system', id: null }, pass.id, null);
    expect(await status(pass.id)).toEqual([{ status: 'voided', void_cause: 'new_code' }]);
  });
});

describe('the notice when there is no email', () => {
  it('shows on the hosted page for two weeks after a replace, with or without a holder email', async () => {
    const pass = await kit.scanPass(tpl);
    const ctx = jobCtxOf({ ctx: kit.ctx });
    const target = { id: pass.id, orgId: pass.orgId };
    expect(await codesReplacedNotice(ctx, target)).toBeUndefined();
    await rotateCode(ctx, pass.id, 'channel_apply:run-2');
    expect(await codesReplacedNotice(ctx, target)).toBe(CHANNEL_COPY.codesReplaced);
    kit.clock.advance(15 * 86_400_000);
    expect(await codesReplacedNotice(ctx, target)).toBeUndefined();
  });
});

describe('who may replace codes', () => {
  it('needs an active user with templates:publish in the org, or a platform admin', async () => {
    const db = kit.env.DB;
    expect(await mayPublish(db, kit.org.id, 'admin-1')).toBe(true);
    expect(await mayPublish(db, kit.org.id, 'nobody')).toBe(false);
    await run(db, 'UPDATE org_memberships SET revoked_at = 1 WHERE user_id = ?', ['admin-1']);
    await run(db, "UPDATE users SET last_roles = '[]' WHERE id = 'admin-1'");
    expect(await mayPublish(db, kit.org.id, 'admin-1')).toBe(false);
    await run(db, 'UPDATE users SET last_roles = ? WHERE id = ?', ['["admin"]', 'admin-1']);
    expect(await mayPublish(db, kit.org.id, 'admin-1')).toBe(true);
  });
});
