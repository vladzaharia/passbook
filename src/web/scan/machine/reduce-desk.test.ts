import { beforeEach, describe, expect, it } from 'vitest';
import { fixtureCard, states } from './fixtures.test-support.ts';
import { answerOf, at, readOf, requestKey, resetIds, step } from './reduce.test-support.ts';
import type { Card, ScanState } from './types.ts';

const base: Card['actions'][number] = {
  id: 'stamp',
  label: 'Add stamp',
  kind: 'add',
  available: true,
  lock: null,
  reason: null,
  amount: { max: 5, presets: [1, 2, 3], default: 1 },
  confirm: false,
  confirmAbove: null,
  cooldownRemainingMs: null,
  armable: 'once',
  rewardLabel: null,
};
beforeEach(resetIds);
function ready(action: Partial<typeof base> = {}): ScanState {
  const scanned = step(states.ready(), readOf('CARD-0001'));
  const key = requestKey(scanned.cmds);
  return step(
    scanned.state,
    answerOf(key, 'ready', null, { card: fixtureCard({ actions: [{ ...base, ...action }] }) }),
    at(100),
  ).state;
}

describe('the desk picks a value action', () => {
  it('opens a picker at the default amount for a range, and sends nothing yet', () => {
    const picked = step(ready(), { type: 'pick', actionId: 'stamp' }, at(200));
    expect(picked.cmds).toEqual([]);
    expect(picked.state.loop).toMatchObject({
      s: 'member',
      picker: { actionId: 'stamp', amount: 1 },
    });
  });

  it('sends a fixed amount at once', () => {
    const fixed = ready({ amount: { fixed: 2 } });
    const picked = step(fixed, { type: 'pick', actionId: 'stamp' }, at(200));
    expect(picked.state.loop).toMatchObject({
      s: 'applying',
      draft: { actionId: 'stamp', amount: 2 },
    });
    expect(picked.cmds).toContainEqual(
      expect.objectContaining({ c: 'act', draft: { actionId: 'stamp', amount: 2 } }),
    );
  });

  it('asks to confirm a take, then sends the chosen amount under a new key', () => {
    const take = ready({ id: 'take', kind: 'take', confirm: true, amount: { fixed: 5 } });
    const open = step(take, { type: 'pick', actionId: 'take' }, at(200));
    expect(open.state.loop).toMatchObject({ s: 'member', picker: { amount: 5 } });
    const sent = step(open.state, { type: 'confirm' }, at(300));
    expect(sent.state.loop).toMatchObject({
      s: 'applying',
      draft: { actionId: 'take', amount: 5 },
    });
    expect(requestKey(sent.cmds)).toEqual(expect.any(String));
  });

  it('steps the amount, and Cancel closes the picker without a request', () => {
    const open = step(ready(), { type: 'pick', actionId: 'stamp' }, at(200)).state;
    const more = step(open, { type: 'amount', value: 3 }, at(210));
    expect(more.state.loop).toMatchObject({ picker: { amount: 3 } });
    const sent = step(more.state, { type: 'confirm' }, at(220));
    expect(sent.cmds).toContainEqual(
      expect.objectContaining({ c: 'act', draft: { actionId: 'stamp', amount: 3 } }),
    );
    const closed = step(more.state, { type: 'cancel' }, at(220));
    expect(closed.state.loop).toMatchObject({ s: 'member', picker: null });
    expect(closed.cmds).toEqual([]);
  });

  it('lets a locked action try, and sends the same draft again with a Manager PIN', () => {
    const locked = ready({ available: false, lock: 'approval', amount: { fixed: 1 } });
    const tried = step(locked, { type: 'pick', actionId: 'stamp' }, at(200));
    const key = requestKey(tried.cmds);
    const needs = step(
      tried.state,
      answerOf(key, 'heads_up', 'needs_approval', {
        action: { id: 'stamp', label: 'Add stamp', kind: 'add' },
      }),
      at(300),
    );
    expect(needs.state.loop).toMatchObject({
      s: 'verdict',
      draft: { actionId: 'stamp', amount: 1 },
    });
    const approved = step(
      needs.state,
      { type: 'approve', staffId: 'staff-1', pin: '123456' },
      at(400),
    );
    expect(approved.state.loop).toMatchObject({
      s: 'applying',
      draft: { actionId: 'stamp', amount: 1, approval: { staffId: 'staff-1', pin: '123456' } },
    });
    expect(requestKey(approved.cmds)).not.toBe(key);
  });

  it('ignores a PIN when the verdict is not needs_approval', () => {
    const state = step(
      step(ready({ amount: { fixed: 1 } }), { type: 'pick', actionId: 'stamp' }, at(200)).state,
      answerOf('x', 'ok', null),
      at(300),
    ).state;
    const result = step(state, { type: 'approve', staffId: 's', pin: '123456' }, at(400));
    expect(result.cmds).toEqual([]);
  });
});
