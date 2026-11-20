import { beforeEach, describe, expect, it, vi } from 'vitest';
import { peekBundle } from './commands-bundle.ts';
import { fixtureOutcome, states } from './fixtures.test-support.ts';
import type { ScanDeps } from './ports.ts';
import { answerOf, at, readOf, requestKey, resetIds, step } from './reduce.test-support.ts';

beforeEach(resetIds);

const bundle = { id: 'b1', name: 'Family', size: 4, checkedIn: 1 };

function okVerdict(over: object = {}) {
  const r = step(states.ready(), readOf('AAAA1111'));
  return step(r.state, answerOf(requestKey(r.cmds), 'ok', null, over), at(100));
}

describe('asking which bundle stands behind a check-in', () => {
  it('an ok door verdict with no bundle asks once, for the pass just scanned', () => {
    const v = okVerdict();
    const peek = v.cmds.filter((c) => c.c === ('bundle' as never));
    expect(peek).toEqual([
      expect.objectContaining({ c: 'bundle', scanId: v.state.recent[0]?.scanId }),
    ]);
  });

  it('does not ask when the answer already has the bundle, ran a group, or was a refusal', () => {
    const asked = (cmds: { c: string }[]) => cmds.some((c) => c.c === 'bundle');
    expect(asked(okVerdict({ bundle }).cmds)).toBe(false);
    expect(asked(okVerdict({ group: { total: 2, done: 2, already: 0, refused: 0 } }).cmds)).toBe(
      false,
    );
    const r = step(states.ready(), readOf('BBBB2222'));
    const refused = step(r.state, answerOf(requestKey(r.cmds), 'refused', 'voided'), at(100));
    expect(asked(refused.cmds)).toBe(false);
  });

  it('shows the bundle on the verdict and holds it for the tap', () => {
    const v = okVerdict();
    const scanId = v.state.recent[0]?.scanId as string;
    const l0 = v.state.loop;
    const closeAt0 = l0.s === 'verdict' ? l0.closeAt : null;
    const r = step(v.state, { type: 'bundle', scanId, bundle }, at(300));
    expect(r.state.loop).toMatchObject({ s: 'verdict', outcome: { bundle } });
    if (r.state.loop.s === 'verdict') expect(r.state.loop.closeAt).toBeGreaterThan(closeAt0 ?? 0);
    expect(r.state.recent[0]?.outcome.bundle).toEqual(bundle);
  });

  it('ignores a bundle for a verdict that is no longer on screen', () => {
    const v = okVerdict();
    const r = step(v.state, { type: 'bundle', scanId: 'someone-else', bundle }, at(300));
    expect(r.state).toBe(v.state);
  });

  it('does not hold the verdict when everyone is already in', () => {
    const v = okVerdict();
    const scanId = v.state.recent[0]?.scanId as string;
    const l0 = v.state.loop;
    const r = step(
      v.state,
      { type: 'bundle', scanId, bundle: { ...bundle, checkedIn: 4 } },
      at(300),
    );
    if (r.state.loop.s === 'verdict' && l0.s === 'verdict')
      expect(r.state.loop.closeAt).toBe(l0.closeAt);
  });
});

describe('the peek request', () => {
  it('resolves the same code and reports the bundle it finds', async () => {
    const dispatch = vi.fn();
    const resolve = vi.fn(async () => fixtureOutcome('ready', null, { bundle }));
    const deps = {
      api: { resolve },
      clock: { now: () => 1 },
      base: () => ({}),
    } as unknown as ScanDeps;
    peekBundle(
      deps,
      { dispatch },
      {
        c: 'bundle',
        key: 'k',
        scanId: 's1',
        input: { code: 'AAAA1111', method: 'camera' } as never,
      },
    );
    await vi.waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith({ type: 'bundle', scanId: 's1', bundle }),
    );
    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'k',
        input: { code: 'AAAA1111', method: 'camera' },
      }),
      expect.anything(),
    );
  });

  it('says nothing for a pass in no bundle, or when the request fails', async () => {
    const dispatch = vi.fn();
    const none = {
      api: { resolve: async () => fixtureOutcome('ready') },
      clock: { now: () => 1 },
      base: () => ({}),
    } as unknown as ScanDeps;
    const bad = {
      api: {
        resolve: async () => {
          throw new Error('offline');
        },
      },
      clock: { now: () => 1 },
      base: () => ({}),
    } as unknown as ScanDeps;
    const cmd = {
      c: 'bundle' as const,
      key: 'k',
      scanId: 's',
      input: { code: 'A', method: 'camera' } as never,
    };
    peekBundle(none, { dispatch }, cmd);
    peekBundle(bad, { dispatch }, cmd);
    await new Promise((r) => setTimeout(r, 20));
    expect(dispatch).not.toHaveBeenCalled();
  });
});
