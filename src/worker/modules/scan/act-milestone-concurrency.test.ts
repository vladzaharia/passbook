import { beforeAll, describe, expect, it } from 'vitest';
import { act, CHECK_IN, kit, out, setupActionFixture } from './act-test-fixtures.ts';
import { codeOf } from './test-kit.ts';

beforeAll(setupActionFixture);

describe('milestones under concurrent arrivals', () => {
  it('the count milestone belongs to exactly one of the scans that cross the 100th arrival', async () => {
    const t = await kit.scanTemplate('Crowd', { actions: [CHECK_IN] });
    const ev = await kit.event({ templateIds: [t] });
    const scanner = await kit.scanner({ eventId: ev.id });
    for (let i = 0; i < 96; i++) {
      const seed = await kit.scanPass(t);
      expect((await out(await act(scanner.headers, codeOf(seed)))).kind).toBe('ok');
    }
    const passes = await Promise.all(Array.from({ length: 6 }, () => kit.scanPass(t)));
    const scanners = await Promise.all(passes.map(() => kit.scanner({ eventId: ev.id })));
    const results = await Promise.all(
      passes.map(async (p, i) => out(await act(scanners[i]?.headers ?? {}, codeOf(p)))),
    );
    expect(results.every((r) => r.kind === 'ok')).toBe(true);
    const arrived = results.map((r) => r.counts.event?.arrived ?? 0).sort((a, b) => a - b);
    expect(arrived).toEqual([97, 98, 99, 100, 101, 102]);
    const hits = results.filter((r) => r.milestone === 'count');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.counts.event?.arrived).toBe(100);
  }, 60_000);
});
