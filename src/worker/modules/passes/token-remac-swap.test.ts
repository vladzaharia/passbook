import { beforeAll, describe, expect, it, vi } from 'vitest';
import { revealToken, tokenMac } from '../../platform/capability-token.ts';
import { all } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { readSystemValue } from '../settings/repo.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { remacCapabilityTokens, WRITE_BUDGET } from './token-remac.ts';

let kit: Kit;
const job = () => jobCtxOf(kit);
const env = () => kit.env as unknown as Record<string, string | undefined>;
const kek = (byte: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)));
const PASSES = 20;

beforeAll(async () => {
  kit = await setupKit();
  for (let i = 0; i < PASSES; i++) await kit.pass();
});

const pin = (root: number, previous: number) => {
  env().KEK_V2 = kek(2);
  env().MAC_KEY_VERSION = String(root);
  env().MAC_KEY_VERSION_PREVIOUS = String(previous);
};

async function sweep(stamp: string) {
  for (let i = 0; i < 12; i++) {
    await remacCapabilityTokens(job());
    if ((await readSystemValue(kit.env.DB, 'tokens.remacDone')) === stamp) return;
  }
  throw new Error(`the sweep ${stamp} did not finish`);
}

/** How many link and device token MACs sit under each root. */
async function roots() {
  const rows = await all<{
    id: string;
    org_id: string;
    download_token: string;
    auth_token: string;
  }>(kit.env.DB, 'SELECT id, org_id, download_token, auth_token FROM passes');
  const count = { 1: 0, 2: 0, other: 0 };
  for (const r of rows) {
    for (const [purpose, stored] of [
      ['pass', r.download_token],
      ['apple-auth', r.auth_token],
    ] as const) {
      const plain = await revealToken(kit.env, purpose, r.id, r.org_id, stored);
      const [one, two] = [
        await tokenMac(kit.env, purpose, plain, 1),
        await tokenMac(kit.env, purpose, plain, 2),
      ];
      if (stored === one) count[1]++;
      else if (stored === two) count[2]++;
      else count.other++;
    }
  }
  return { ...count, total: rows.length * 2 };
}

describe('tokens.remac sweeps belong to one version pair', () => {
  it('moves at most the write budget a run', async () => {
    pin(2, 1);
    await remacCapabilityTokens(job());
    const r = await roots();
    expect(r.other).toBe(0);
    expect(r[2]).toBeGreaterThan(0);
    expect(r[2]).toBeLessThanOrEqual(WRITE_BUDGET);
    expect(r[1]).toBe(r.total - r[2]);
    expect(await readSystemValue(kit.env.DB, 'tokens.remacDone')).toBeNull();
  });

  it('starts over when the pins are swapped mid-sweep', async () => {
    pin(1, 2);
    await sweep('2>1');
    expect(await roots()).toMatchObject({ 1: PASSES * 2, 2: 0, other: 0 });
  });

  it('sweeps again when the first pair is pinned after the swap finished', async () => {
    pin(2, 1);
    await remacCapabilityTokens(job());
    // The finished sweep of 2>1 says nothing about 1>2.
    expect(await readSystemValue(kit.env.DB, 'tokens.remacDone')).toBeNull();
    await sweep('1>2');
    expect(await roots()).toMatchObject({ 1: 0, 2: PASSES * 2, other: 0 });
    delete env().MAC_KEY_VERSION_PREVIOUS;
    expect((await roots()).other).toBe(0);
  });

  it('reports the unreadable total and the skipped ids when it finishes', async () => {
    pin(1, 2);
    const ctx = job();
    const info = vi.spyOn(ctx.log, 'info');
    for (let i = 0; i < 12; i++) {
      await remacCapabilityTokens(ctx);
      if ((await readSystemValue(kit.env.DB, 'tokens.remacDone')) === '2>1') break;
    }
    const done = info.mock.calls.find(
      ([, f]) => (f as { code?: string })?.code === 'TOKEN_REMAC_DONE',
    );
    expect(done?.[1]).toMatchObject({ code: 'TOKEN_REMAC_DONE', stamp: '2>1', unreadable: 0 });
  });

  it('logs an error when stored MACs match the root and no previous root is set', async () => {
    // Rows sit under root 1; pinning root 2 without a previous root breaks every link.
    env().MAC_KEY_VERSION = '2';
    delete env().MAC_KEY_VERSION_PREVIOUS;
    const ctx = job();
    const error = vi.spyOn(ctx.log, 'error');
    const codes = () => error.mock.calls.map(([, f]) => (f as { code?: string })?.code);
    await remacCapabilityTokens(ctx);
    expect(codes()).toContain('TOKEN_MAC_ROOT_MISMATCH');
    // Throttled: the probe runs every few hours, not every minute.
    error.mockClear();
    await remacCapabilityTokens(ctx);
    expect(codes()).not.toContain('TOKEN_MAC_ROOT_MISMATCH');
    kit.clock.advance(7 * 60 * 60_000);
    await remacCapabilityTokens(ctx);
    expect(codes()).toContain('TOKEN_MAC_ROOT_MISMATCH');
    // A matching root logs nothing.
    kit.clock.advance(7 * 60 * 60_000);
    error.mockClear();
    env().MAC_KEY_VERSION = '1';
    await remacCapabilityTokens(ctx);
    expect(codes()).not.toContain('TOKEN_MAC_ROOT_MISMATCH');
  });
});
