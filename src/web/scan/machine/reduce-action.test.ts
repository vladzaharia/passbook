import { beforeEach, describe, expect, it } from 'vitest';
import { fixtureCard, states } from './fixtures.test-support.ts';
import { answerOf, at, readOf, requestKey, resetIds, step } from './reduce.test-support.ts';
import type { Card } from './types.ts';

const action: Card['actions'][number] = {
  id: 'check_in',
  label: 'Check in',
  kind: 'check_in',
  available: true,
  lock: null,
  reason: null,
  amount: null,
  confirm: false,
  confirmAbove: null,
  cooldownRemainingMs: null,
  armable: 'sticky',
  rewardLabel: null,
};
beforeEach(resetIds);
function ready(over: Partial<typeof action> = {}) {
  const scanned = step(states.ready(), readOf('CHECKIN-0001'));
  const key = requestKey(scanned.cmds);
  return step(
    scanned.state,
    answerOf(key, 'ready', null, {
      card: fixtureCard({ actions: [{ ...action, ...over }] }),
    }),
    at(100),
  ).state;
}
describe('explicit action-card check-in', () => {
  it('uses a fresh mutation key and waits for the server before accepting', () => {
    const state = ready();
    const result = step(state, { type: 'pick', actionId: 'check_in' }, at(200));
    expect(result.state.loop).toMatchObject({
      s: 'applying',
      draft: { actionId: 'check_in', amount: null },
      slow: false,
    });
    expect(result.cmds).toContainEqual({ c: 'camera', op: 'pause' });
    const act = result.cmds.find((c) => c.c === 'act');
    expect(act).toMatchObject({ draft: { actionId: 'check_in', amount: null } });
    if (state.loop.s !== 'member') throw new Error('Expected ready card');
    expect(act && 'key' in act ? act.key : null).not.toBe(state.loop.input.id);
    expect(result.state.recent).toHaveLength(0);
    const accepted = step(result.state, answerOf(requestKey(result.cmds)), at(300));
    expect(accepted.state.loop).toMatchObject({ s: 'verdict', outcome: { kind: 'ok' } });
    expect(accepted.state.recent).toHaveLength(1);
  });
  it('ignores a second click while the first request is applying', () => {
    const once = step(ready(), { type: 'pick', actionId: 'check_in' }, at(200));
    const twice = step(once.state, { type: 'pick', actionId: 'check_in' }, at(201));
    expect(twice.state).toBe(once.state);
    expect(twice.cmds).toEqual([]);
  });
  it.each([{ available: false }, { lock: 'role' as const }, { kind: 'add' as const }])(
    'does not run an unavailable or unsupported action %j',
    (over) => {
      const state = ready(over);
      const result = step(state, { type: 'pick', actionId: 'check_in' });
      expect(result.state).toBe(state);
      expect(result.cmds).toEqual([]);
    },
  );
  it('rejects unknown actions, blocked sessions and stale clicks', () => {
    const state = ready();
    expect(step(state, { type: 'pick', actionId: 'unknown' }).cmds).toEqual([]);
    expect(
      step({ ...state, block: 'revoked' }, { type: 'pick', actionId: 'check_in' }).cmds,
    ).toEqual([]);
    expect(step({ ...state, started: false }, { type: 'pick', actionId: 'check_in' }).cmds).toEqual(
      [],
    );
    expect(step(states.ready(), { type: 'pick', actionId: 'check_in' }).cmds).toEqual([]);
  });
  it('shows a network failure when offline without accepting or sending an action', () => {
    const result = step({ ...ready(), online: false }, { type: 'pick', actionId: 'check_in' });
    expect(result.state.loop).toMatchObject({
      s: 'verdict',
      outcome: { kind: 'system', reason: 'network' },
    });
    expect(result.cmds.some((c) => c.c === 'act')).toBe(false);
    expect(result.state.recent.filter((r) => r.outcome.kind === 'ok')).toHaveLength(0);
  });
});
