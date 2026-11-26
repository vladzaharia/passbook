import { beforeEach, describe, expect, it } from 'vitest';
import {
  captureLogs,
  ctx,
  ledger,
  resetLedger,
  rows,
  seedCreated,
  seedGrant,
  setup,
} from './harness.ts';

beforeEach(resetLedger);

async function many(n: number, group = 'g-dev') {
  const s = setup();
  for (let i = 0; i < n; i++) {
    s.pocket.addUser(`u${i}`, { groups: [group] });
    await seedGrant(`u${i}`);
  }
  return s;
}

describe('breaker', () => {
  it('stops a run at 25 removals and alerts, leaving later accounts untouched', async () => {
    const s = await many(27);
    const run = ctx({ ref: 'drain-1', actor: { kind: 'system', job: 'drain' } });
    let stopped = 0;
    const logs = await captureLogs(async () => {
      for (let i = 0; i < 27; i++) {
        if (i === 20) s.clock.now += 61_000;
        try {
          await s.api.apply(`u${i}`, { remove: ['developer'] }, run);
        } catch (e) {
          if (/^IDP_BREAKER/.test(String((e as Error).message))) stopped += 1;
          else throw e;
        }
      }
    });
    expect(stopped).toBe(2);
    expect(s.pocket.s.users.get('u24')?.groups).toEqual([]);
    expect(s.pocket.s.users.get('u25')?.groups).toEqual(['g-dev']);
    expect(logs.lines.some((l) => l.includes('binding.breaker'))).toBe(true);
    expect((await ledger()).filter((r) => r.phase === 'breaker')).toHaveLength(2);
    expect(await rows('idp_breaker')).toMatchObject([{ ref: 'drain-1', removals: 25 }]);
  });

  it('counts per run: another ref has its own 25', async () => {
    const s = await many(2);
    await s.api.apply('u0', { remove: ['developer'] }, ctx({ ref: 'run-a' }));
    await s.api.apply('u1', { remove: ['developer'] }, ctx({ ref: 'run-b' }));
    expect(await rows('idp_breaker')).toMatchObject([
      { ref: 'run-a', removals: 1 },
      { ref: 'run-b', removals: 1 },
    ]);
  });

  it('counts every role of one apply', async () => {
    const s = setup();
    s.pocket.addUser('u1', { groups: ['g-dev', 'g-console'] });
    await seedGrant('u1', 'developer');
    await seedGrant('u1', 'console');
    await s.api.apply('u1', { remove: ['developer', 'console'] }, ctx());
    expect(await rows('idp_breaker')).toMatchObject([{ removals: 2, disables: 0 }]);
  });

  it('stops a run at 5 disables', async () => {
    const s = setup();
    for (let i = 0; i < 6; i++) {
      s.pocket.addUser(`c${i}`, { groups: ['g-dev'] });
      await seedCreated(`c${i}`);
    }
    const run = ctx({ ref: 'offboard-1' });
    for (let i = 0; i < 5; i++) await s.api.setDisabled(`c${i}`, true, run);
    s.clock.now += 61_000;
    await expect(s.api.setDisabled('c5', true, run)).rejects.toThrow(/^IDP_BREAKER/);
    expect(s.pocket.s.users.get('c5')?.disabled).toBe(false);
    expect(await rows('idp_breaker')).toMatchObject([{ removals: 0, disables: 5 }]);
  });

  it('does not count adds, skipped removals or no-ops', async () => {
    const s = setup();
    s.pocket.addUser('u1', { groups: ['g-dev'] });
    await s.api.apply('u1', { add: ['developer'] }, ctx());
    await s.api.apply('u1', { remove: ['console'] }, ctx());
    await s.api.apply('u1', { remove: ['developer'] }, ctx());
    expect(await rows('idp_breaker')).toEqual([]);
  });

  it('a run of dry-run removals counts too, so a dry run shows the trip', async () => {
    const s = setup('v2', { WRITE_MODE: 'dry_run' });
    for (let i = 0; i < 26; i++) {
      s.pocket.addUser(`d${i}`, { groups: ['g-dev'] });
      await seedGrant(`d${i}`);
    }
    let tripped = 0;
    for (let i = 0; i < 26; i++) {
      if (i % 15 === 0) s.clock.now += 61_000;
      try {
        await s.api.apply(`d${i}`, { remove: ['developer'] }, ctx({ ref: 'dry-run-1' }));
      } catch (e) {
        if (/^IDP_BREAKER/.test(String((e as Error).message))) tripped += 1;
      }
    }
    expect(tripped).toBe(1);
    expect(s.pocket.writes()).toHaveLength(0);
  });
});
