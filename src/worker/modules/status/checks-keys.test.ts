import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isolatedKeysetDatabase } from '../../../../test/helpers/credential-keyset.ts';
import { makeEnv, TEST_NOW } from '../../../../test/helpers/index.ts';
import { ManualClock } from '../../platform/clock.ts';
import { run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { extractMacRoot } from '../../platform/mac-roots.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { writeSystemValue } from '../settings/repo.ts';
import { checkKeys } from './checks-keys.ts';

const kek = (byte: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)));
const HOUR = 3_600_000;
let base: AppEnv;

beforeAll(async () => {
  base = await makeEnv({ KEK_V1: kek(1) });
});
beforeEach(async () => {
  await run(env.DB, "DELETE FROM settings WHERE scope = 'system'");
});

const keys = (overrides: Record<string, unknown>) =>
  checkKeys(
    createServiceContext({ ...base, ...overrides } as AppEnv, { clock: new ManualClock(TEST_NOW) }),
  );
const done = (value: object) => writeSystemValue(env.DB, 'keys.rewrapDone', value, TEST_NOW);

describe('Status keys', () => {
  it('is verified for the plain ring and reports no key material', async () => {
    const s = await keys({});
    expect(s).toMatchObject({
      id: 'keys',
      state: 'verified',
      data: { current: 1, kekVersions: '1', rewrapState: 'idle', retirable: '' },
    });
    expect(JSON.stringify(s)).not.toContain(kek(1));
  });

  it('fails when root 1 is gone (KEK_V1 removed without MAC_ROOT_V1)', async () => {
    const s = await keys({ KEK_V1: undefined, KEK_V2: kek(2) });
    expect(s.state).toBe('failing');
    expect(s.detail).toContain('Root 1 is missing');
  });

  it('is verified with the extracted root in place of KEK_V1', async () => {
    const root = await extractMacRoot(kek(1));
    expect(await keys({ KEK_V1: undefined, KEK_V2: kek(2), MAC_ROOT_V1: root })).toMatchObject({
      state: 'verified',
      data: { kekVersions: '2', macRoots: '1' },
    });
    // A pin on the retired version is fine while its root is set.
    expect(
      await keys({
        KEK_V1: undefined,
        KEK_V2: kek(2),
        MAC_ROOT_V1: root,
        MAC_KEY_VERSION: '1',
      }),
    ).toMatchObject({ state: 'verified' });
  });

  it('fails on a MAC root that does not match its KEK, while the KEK still works', async () => {
    const s = await keys({ KEK_V2: kek(2), MAC_ROOT_V1: await extractMacRoot(kek(9)) });
    expect(s.state).toBe('failing');
    expect(s.detail).toContain('MAC_ROOT_V1 does not match KEK_V1');
  });

  it('fails when retained evidence was made under a key ring that is gone', async () => {
    const DB = await isolatedKeysetDatabase();
    await ensureCredentialRefKeyset(DB, base);
    const root = await extractMacRoot(kek(1));
    expect(await keys({ DB, KEK_V1: undefined, KEK_V2: kek(2) })).toMatchObject({
      state: 'failing',
      detail: expect.stringContaining('Retained evidence'),
    });
    expect(await keys({ DB, KEK_V1: undefined, KEK_V2: kek(2), MAC_ROOT_V1: root })).toMatchObject({
      state: 'verified',
    });
    expect(await keys({ DB, KEK_V1: kek(7) })).toMatchObject({
      state: 'failing',
      detail: expect.stringContaining('Retained evidence'),
    });
  });

  it('shows the rewrap and lists the version that may be deleted', async () => {
    const ring = { KEK_V2: kek(2), MAC_ROOT_V1: await extractMacRoot(kek(1)) };
    expect(await keys(ring)).toMatchObject({
      state: 'verified',
      data: { rewrapState: 'running', retirable: '' },
    });
    await done({
      stamp: '1>2',
      unreadable: 0,
      at: TEST_NOW,
      startedAt: TEST_NOW - HOUR,
      remaining: {},
    });
    // Finished, but the cursors that were sealed under V1 may still be live.
    expect(await keys(ring)).toMatchObject({ data: { rewrapState: 'done', retirable: '' } });
    await done({
      stamp: '1>2',
      unreadable: 0,
      at: TEST_NOW,
      startedAt: TEST_NOW - 25 * HOUR,
      remaining: {},
    });
    expect(await keys(ring)).toMatchObject({ state: 'verified', data: { retirable: '1' } });
    // Rows the sweep left on V1, or no counts at all, hold it back.
    await done({
      stamp: '1>2',
      unreadable: 0,
      at: TEST_NOW,
      startedAt: TEST_NOW - 25 * HOUR,
      remaining: { '1': 2 },
    });
    expect(await keys(ring)).toMatchObject({ data: { retirable: '' } });
    await done({ stamp: '1>2', unreadable: 0, at: TEST_NOW, startedAt: TEST_NOW - 25 * HOUR });
    expect(await keys(ring)).toMatchObject({ data: { retirable: '' } });
    // Version 1 is a root in use: without its root it is not retirable, and Status fails anyway.
    expect(await keys({ KEK_V2: kek(2) })).toMatchObject({ data: { retirable: '' } });
    // Version 2 is the current KEK and never retirable.
    expect(await keys({ KEK_V2: kek(2) })).toMatchObject({ state: 'verified' });
  });

  it('is degraded while the finished rewrap left rows it could not open', async () => {
    await done({
      stamp: '1>2',
      unreadable: 3,
      at: TEST_NOW,
      startedAt: TEST_NOW - 30 * HOUR,
      remaining: { '1': 3 },
    });
    const s = await keys({ KEK_V2: kek(2) });
    expect(s).toMatchObject({ state: 'degraded', data: { rewrapUnreadable: 3, retirable: '' } });
    expect(s.detail).toContain('3 rows');
  });
});
