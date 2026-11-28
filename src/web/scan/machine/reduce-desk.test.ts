import { beforeEach, describe, expect, it } from 'vitest';
import { expectSecretAbsent } from '../../../../test/helpers/secret-absent.ts';
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
    // The PIN rides on the command; the state a screen can read never holds it.
    expect(approved.state.loop).toMatchObject({
      s: 'applying',
      draft: { actionId: 'stamp', amount: 1 },
    });
    expectSecretAbsent(JSON.stringify(approved.state), '123456');
    expect(approved.cmds).toContainEqual(
      expect.objectContaining({
        c: 'act',
        draft: expect.objectContaining({ approval: { staffId: 'staff-1', pin: '123456' } }),
      }),
    );
    expect(requestKey(approved.cmds)).not.toBe(key);
  });

  it('opens a typed set at the value the card holds, and sends it with the card version', () => {
    const set = ready({
      id: 'tier',
      kind: 'set',
      amount: null,
      input: { type: 'string', label: 'Tier', enum: ['Silver', 'Gold'] },
    });
    const open = step(set, { type: 'pick', actionId: 'tier' }, at(200));
    expect(open.cmds).toEqual([]);
    expect(open.state.loop).toMatchObject({ picker: { actionId: 'tier', value: 5 } });
    const typed = step(open.state, { type: 'value', value: 'Gold' }, at(210));
    const sent = step(typed.state, { type: 'confirm' }, at(220));
    expect(sent.cmds).toContainEqual(
      expect.objectContaining({
        c: 'act',
        draft: expect.objectContaining({ actionId: 'tier', value: 'Gold', expectedVersion: 1 }),
      }),
    );
  });

  it('sends a set with a fixed value at once', () => {
    const fixed = ready({ id: 'gold', kind: 'set', amount: null });
    const sent = step(fixed, { type: 'pick', actionId: 'gold' }, at(200));
    expect(sent.state.loop).toMatchObject({ s: 'applying', draft: { actionId: 'gold' } });
  });

  it('does not keep the PIN once it was sent', () => {
    const locked = ready({ available: false, lock: 'approval', amount: { fixed: 1 } });
    const tried = step(locked, { type: 'pick', actionId: 'stamp' }, at(200));
    const needs = step(
      tried.state,
      answerOf(requestKey(tried.cmds), 'heads_up', 'needs_approval', {
        action: { id: 'stamp', label: 'Add stamp', kind: 'add' },
      }),
      at(300),
    );
    const approved = step(needs.state, { type: 'approve', pin: '123456' }, at(400));
    const done = step(approved.state, answerOf(requestKey(approved.cmds), 'ok', null), at(500));
    expect(done.state.loop).toMatchObject({ s: 'verdict', draft: { actionId: 'stamp' } });
    expectSecretAbsent(JSON.stringify(done.state.loop), '123456');
  });

  it('shows the same needs_approval card again with the tries left, then locked', () => {
    const locked = ready({ available: false, lock: 'approval', amount: { fixed: 1 } });
    const tried = step(locked, { type: 'pick', actionId: 'stamp' }, at(200));
    const needs = step(
      tried.state,
      answerOf(requestKey(tried.cmds), 'heads_up', 'needs_approval', {
        action: { id: 'stamp', label: 'Add stamp', kind: 'add' },
      }),
      at(300),
    );
    const sent = step(needs.state, { type: 'approve', pin: '482913' }, at(400));
    const wrong = step(
      sent.state,
      { type: 'fail', key: requestKey(sent.cmds), error: 'pin_invalid', triesLeft: 2 },
      at(500),
    );
    expect(wrong.state.loop).toMatchObject({
      s: 'verdict',
      outcome: { reason: 'needs_approval' },
      draft: { actionId: 'stamp' },
      pin: { triesLeft: 2 },
    });
    expectSecretAbsent(JSON.stringify(wrong.state.loop), '482913');
    const again = step(wrong.state, { type: 'approve', pin: '735261' }, at(600));
    const shut = step(
      again.state,
      { type: 'fail', key: requestKey(again.cmds), error: 'pin_locked' },
      at(700),
    );
    expect(shut.state.loop).toMatchObject({ s: 'verdict', pin: { locked: true } });
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
