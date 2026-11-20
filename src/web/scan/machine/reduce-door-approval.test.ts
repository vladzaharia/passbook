import { beforeEach, describe, expect, it } from 'vitest';
import { states } from './fixtures.test-support.ts';
import { answerOf, at, readOf, requestKey, resetIds, step } from './reduce.test-support.ts';

beforeEach(resetIds);

function held() {
  const scanned = step(states.ready(), readOf('PASS-0001'));
  return step(
    scanned.state,
    answerOf(requestKey(scanned.cmds), 'heads_up', 'needs_approval', {
      approvals: true,
      action: { id: 'redeem', label: 'Redeem 1 Free coffee', kind: 'add' },
    }),
    at(100),
  );
}

describe('a Manager PIN at the door', () => {
  it('keeps the draft the read went with, so the PIN can re-send it', () => {
    expect(held().state.loop).toMatchObject({
      s: 'verdict',
      outcome: { reason: 'needs_approval' },
      draft: { actionId: 'auto' },
    });
  });

  it('re-sends that read with the approval under a new key', () => {
    const approved = step(held().state, { type: 'approve', staffId: 'm1', pin: '482913' }, at(200));
    expect(approved.state.loop).toMatchObject({
      s: 'applying',
      draft: { actionId: 'auto', approval: { staffId: 'm1', pin: '482913' } },
    });
    expect(approved.cmds).toContainEqual(
      expect.objectContaining({ c: 'act', input: expect.objectContaining({ code: 'PASS-0001' }) }),
    );
  });

  it('brings the hold back with the tries left, without the PIN', () => {
    const sent = step(held().state, { type: 'approve', pin: '482913' }, at(200));
    const wrong = step(
      sent.state,
      { type: 'fail', key: requestKey(sent.cmds), error: 'pin_invalid', triesLeft: 2 },
      at(300),
    );
    expect(wrong.state.loop).toMatchObject({
      s: 'verdict',
      outcome: { reason: 'needs_approval' },
      pin: { triesLeft: 2 },
    });
    expect(JSON.stringify(wrong.state)).not.toContain('482913');
  });

  it('a hold that is not about approval keeps no draft', () => {
    const scanned = step(states.ready(), readOf('PASS-0002'));
    const done = step(
      scanned.state,
      answerOf(requestKey(scanned.cmds), 'heads_up', 'already_done'),
      at(100),
    );
    expect(done.state.loop).not.toHaveProperty('draft');
  });
});
