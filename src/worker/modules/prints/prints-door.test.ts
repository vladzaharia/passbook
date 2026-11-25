import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth, makeOrg } from '../../../../test/helpers/index.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { createApp } from '../../app.ts';
import { all, first, run } from '../../platform/db.ts';
import { seedBundlePrincipal } from '../bundles/test-auth-fixtures.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { newPassCode } from '../passes/new-code.ts';
import { voidPass } from '../passes/service.ts';
import {
  key,
  ORIGIN,
  type ScanKit,
  setupScanKit,
  startScanCredentialTransfer,
} from '../scan/test-kit.ts';
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

const call = (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
  app.request(
    `${ORIGIN}/api/v1${path}`,
    {
      method,
      headers: { ...headers, ...json, ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    kit.env,
  );
const printable = async (holderEmail?: string, mode?: 'live' | 'test') => {
  const pass = await kit.scanPass(
    tpl,
    {},
    { ...(holderEmail ? { holderEmail } : {}), ...(mode ? { mode } : {}) },
  );
  expect(
    (
      await call(
        'PUT',
        `/passes/${pass.id}/channels`,
        { channels: { paper: 'on' } },
        mode === 'test' ? { 'x-passbook-mode': 'test' } : {},
      )
    ).status,
  ).toBe(200);
  return pass;
};
const mint = async (passId: string, extra: Record<string, string> = {}) =>
  (await (await call('POST', `/passes/${passId}/prints`, undefined, extra)).json()) as {
    id: string;
    code: string;
  };
const status = (passId: string) =>
  all<{ status: string; void_cause: string | null }>(
    kit.env.DB,
    'SELECT status, void_cause FROM pass_prints WHERE pass_id = ? ORDER BY generation DESC',
    [passId],
  );
const resolve = async (s: { headers: Record<string, string> }, code: string, method = 'camera') => {
  const res = await kit.post(s.headers, '/resolve', {
    idempotencyKey: key(),
    input: { code, method },
    clientTs: kit.clock.now(),
  });
  return (await res.json()) as ScanOutcome;
};

describe('print codes at the door', () => {
  it('resolves a print code to its pass and runs the normal pipeline', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const pass = await printable();
    const p = await mint(pass.id);
    const out = await resolve(s, p.code);
    expect(out.kind).not.toBe('refused');
    expect(out.card).not.toBeNull();
    // Typed with spaces and lower case, like a person copying the printed code.
    const typed = `${p.code.slice(0, 5)} ${p.code.slice(5).toLowerCase()}`;
    expect((await resolve(s, typed, 'manual')).kind).not.toBe('refused');
    // The pass's own scan code still works: prints add a credential, they do not replace one.
    expect((await resolve(s, pass.scanCode ?? '')).kind).not.toBe('refused');
  });

  it('answers print_replaced for a reprinted code and print_voided for a voided one', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const pass = await printable();
    const first = await mint(pass.id);
    const second = await mint(pass.id);
    expect(await resolve(s, first.code)).toMatchObject({
      kind: 'refused',
      reason: 'print_replaced',
    });
    expect((await resolve(s, second.code)).kind).not.toBe('refused');
    await call('POST', `/passes/${pass.id}/prints/${second.id}/void`);
    expect(await resolve(s, second.code)).toMatchObject({
      kind: 'refused',
      reason: 'print_voided',
    });
  });

  it('does not resolve in another org, another mode, or for a code that was never minted', async () => {
    const pass = await printable();
    const p = await mint(pass.id);
    const other = await makeOrg(kit.fx);
    const foreign = await kit.scanner({ orgId: other.id, templateIds: [tpl] });
    const seen = await resolve(foreign, p.code);
    expect(seen).toMatchObject({ kind: 'refused', card: null });
    const testDoor = await kit.scanner({ templateIds: [tpl], mode: 'test' });
    expect(await resolve(testDoor, p.code)).toMatchObject({ kind: 'refused', reason: 'live_pass' });
    const s = await kit.scanner({ templateIds: [tpl] });
    const made = `P${p.code.slice(1).split('').reverse().join('')}`;
    expect(await resolve(s, made)).toMatchObject({ kind: 'refused', reason: 'not_found' });
  });

  it('stores a unique keyed hash and the roster hash, never the code', async () => {
    const pass = await printable();
    const p = await mint(pass.id);
    const row = await first<{ print_code_hash: string; roster_hash: string }>(
      kit.env.DB,
      'SELECT print_code_hash, roster_hash FROM pass_prints WHERE id = ?',
      [p.id],
    );
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(p.code));
    const expected = [...new Uint8Array(digest).slice(0, 16)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    expect(row?.roster_hash).toBe(expected);
    expect(row?.print_code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(p.code);
  });
});

describe('paper off at the door', () => {
  it('refuses channel_off without voiding, and works again when paper is back on', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const pass = await printable();
    const p = await mint(pass.id);
    await run(
      kit.env.DB,
      "INSERT OR REPLACE INTO settings (scope, key, value, updated_by, updated_at) VALUES ('platform', 'print.enabled', 'false', 'test', 1)",
    );
    clearSettingsCache(kit.env.DB);
    try {
      expect(await resolve(s, p.code)).toMatchObject({
        kind: 'refused',
        reason: 'channel_off',
        channel: 'paper',
      });
      expect((await status(pass.id))[0]?.status).toBe('active');
    } finally {
      await run(
        kit.env.DB,
        "INSERT OR REPLACE INTO settings (scope, key, value, updated_by, updated_at) VALUES ('platform', 'print.enabled', 'true', 'test', 1)",
      );
      clearSettingsCache(kit.env.DB);
    }
    expect((await resolve(s, p.code)).kind).not.toBe('refused');
  });
});

describe('what ends a print', () => {
  it('pass void', async () => {
    const pass = await printable();
    await mint(pass.id);
    await voidPass(jobCtxOf(kit), { type: 'user', id: 'admin-1' }, pass.id, null);
    expect(await status(pass.id)).toEqual([{ status: 'voided', void_cause: 'pass_voided' }]);
  });

  it('holder change in a credential transfer', async () => {
    const pass = await printable('first@example.com');
    const p = await mint(pass.id);
    await startScanCredentialTransfer(kit, pass.id, {
      target: { holderEmail: 'second@example.com', ownerUserId: null },
    });
    const [row] = await status(pass.id);
    expect(row?.status).toBe('voided');
    expect(['holder_change', 'transfer']).toContain(row?.void_cause);
    const s = await kit.scanner({ templateIds: [tpl] });
    expect((await resolve(s, p.code)).kind).toBe('refused');
  });

  it('a manual New code, but not a channel change', async () => {
    const pass = await printable();
    const p = await mint(pass.id);
    await call('PUT', `/passes/${pass.id}/channels`, { channels: { apple: 'off' } });
    expect((await status(pass.id))[0]?.status).toBe('active');
    await newPassCode(jobCtxOf(kit), { type: 'system', id: null }, pass.id, null);
    expect(await status(pass.id)).toEqual([{ status: 'voided', void_cause: 'new_code' }]);
    const s = await kit.scanner({ templateIds: [tpl] });
    expect(await resolve(s, p.code)).toMatchObject({ kind: 'refused', reason: 'print_voided' });
  });
});

describe('a print whose pass cannot admit', () => {
  it('a voided pass answers with the pass, not a voided print', async () => {
    const pass = await printable();
    const p = await mint(pass.id);
    await voidPass(jobCtxOf(kit), { type: 'user', id: 'admin-1' }, pass.id, null);
    const s = await kit.scanner({ templateIds: [tpl] });
    const out = await resolve(s, p.code);
    expect(out.kind).toBe('refused');
    expect(out).not.toMatchObject({ reason: 'print_voided' });
  });

  it('a test print on a live scanner says test_pass', async () => {
    const pass = await printable(undefined, 'test');
    const p = await mint(pass.id, { 'x-passbook-mode': 'test' });
    const s = await kit.scanner({ templateIds: [tpl] });
    expect(await resolve(s, p.code)).toMatchObject({ kind: 'refused', reason: 'test_pass' });
  });
});

describe('typed numbers on a printed pass', () => {
  it('checks a typed serial once a print exists, and not before', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const pass = await printable();
    expect(await resolve(s, pass.serial, 'manual')).toMatchObject({ kind: 'ready' });
    await mint(pass.id);
    expect(await resolve(s, pass.serial, 'manual')).toMatchObject({
      kind: 'heads_up',
      reason: 'check_required',
      flags: ['Typed number'],
    });
  });
});

describe('print codes ignore the digital channels', () => {
  it('admits a print code on a pass whose digital channels are all off', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const pass = await printable();
    const p = await mint(pass.id);
    expect(
      (
        await call('PUT', `/passes/${pass.id}/channels`, {
          channels: { mobile: 'off', apple: 'off' },
        })
      ).status,
    ).toBe(200);
    expect(await resolve(s, p.code)).toMatchObject({ kind: 'ready' });
  });
});
