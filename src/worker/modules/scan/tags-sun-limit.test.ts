import { beforeAll, describe, expect, it } from 'vitest';
import { type SunKeyset, sunKeyset, sunTap } from './sun-test-fixtures.ts';
import { type TagScanFixture, tagScanFixture } from './tags-scan-test-fixtures.ts';
import { noteSunFailure, SUN_FAILURES_PER_WINDOW, verifiedSunId } from './tags-sun.ts';
import { key } from './test-kit.ts';

let f: TagScanFixture;
let ks: SunKeyset;
beforeAll(async () => {
  f = await tagScanFixture();
  ks = await sunKeyset(f.kit, f.kit.org.id);
});

const uid7 = () =>
  `04${(Math.random() * 2 ** 48).toString(16).replace('.', '').padEnd(12, '0').slice(0, 12)}`;
const device = () => ({
  orgId: f.kit.org.id,
  mode: 'live' as const,
  actorKey: `k-${key()}`,
  scanner: null as { id: string } | null,
});
const fail = async (who: ReturnType<typeof device>, times: number) => {
  for (let i = 0; i < times; i++) await noteSunFailure(f.kit.ctx, who, 'TAG_SUN_VERIFY');
};
const read = async (who: ReturnType<typeof device>) =>
  verifiedSunId(f.kit.ctx, who as never, await sunTap(ks, uid7(), 1));

describe('the per-device SUN failure limit', () => {
  it('reads below the limit, and the read at it, still verify', async () => {
    const who = device();
    await fail(who, SUN_FAILURES_PER_WINDOW - 1);
    expect(await read(who)).toHaveProperty('id');
    await fail(who, 1);
    await expect(read(who)).rejects.toMatchObject({
      status: 429,
      code: 'TAG_SUN_RATE_LIMITED',
    });
  });

  it('does not count successful reads', async () => {
    const who = device();
    for (let i = 0; i < SUN_FAILURES_PER_WINDOW + 2; i++) await read(who);
    expect(await read(who)).toHaveProperty('id');
  });

  it('refuses a bad tap past the limit before verifying it', async () => {
    const who = device();
    await fail(who, SUN_FAILURES_PER_WINDOW);
    const bad = await sunTap(ks, uid7(), 1, { m: '0000000000000000' });
    await expect(verifiedSunId(f.kit.ctx, who as never, bad)).rejects.toMatchObject({
      code: 'TAG_SUN_RATE_LIMITED',
    });
  });

  it('lets the device read again when the window passes', async () => {
    const who = device();
    await fail(who, SUN_FAILURES_PER_WINDOW);
    await expect(read(who)).rejects.toMatchObject({ code: 'TAG_SUN_RATE_LIMITED' });
    f.kit.clock.advance(600_000);
    expect(await read(who)).toHaveProperty('id');
  });

  it('limits each device on its own', async () => {
    const a = device();
    const b = device();
    await fail(a, SUN_FAILURES_PER_WINDOW);
    await expect(read(a)).rejects.toMatchObject({ code: 'TAG_SUN_RATE_LIMITED' });
    expect(await read(b)).toHaveProperty('id');
    const scanner = { ...b, scanner: { id: `s-${key()}` } };
    expect(await read(scanner)).toHaveProperty('id');
  });
});
