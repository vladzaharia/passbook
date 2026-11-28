import { beforeEach, describe, expect, it } from 'vitest';
import { expectSecretAbsent } from '../../../../test/helpers/secret-absent.ts';
import type { OfflineMode } from '../../../shared/scan-offline.ts';
import { states } from './fixtures.test-support.ts';
import { answerOf, at, hasCmd, readOf, requestKey, resetIds, step } from './reduce.test-support.ts';

beforeEach(resetIds);

function held(mode: OfflineMode = 'stop') {
  const ready = states.ready();
  const scanned = step({ ...ready, offline: { ...ready.offline, mode } }, readOf('PASS-0001'));
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

  it('re-sends that read with the approval under a new key, and keeps the PIN out of state', () => {
    const approved = step(held().state, { type: 'approve', staffId: 'm1', pin: '482913' }, at(200));
    expect(approved.state.loop).toMatchObject({ s: 'applying', draft: { actionId: 'auto' } });
    expectSecretAbsent(JSON.stringify(approved.state), '482913');
    expect(approved.cmds).toContainEqual(
      expect.objectContaining({
        c: 'act',
        input: expect.objectContaining({ code: 'PASS-0001' }),
        draft: expect.objectContaining({ approval: { staffId: 'm1', pin: '482913' } }),
      }),
    );
  });

  it('a Manager approving makes the buddy nod, and a plain check-in does not', () => {
    const sent = step(held().state, { type: 'approve', staffId: 'm1', pin: '482913' }, at(200));
    const ok = step(sent.state, answerOf(requestKey(sent.cmds), 'ok', null), at(300));
    expect(ok.cmds).toContainEqual({ c: 'beat', beat: 'nod' });
    // The tray and its opener are gone: focus goes to the verdict word, not to the page.
    expect(ok.cmds).toContainEqual({ c: 'focus', target: 'card-heading' });
    const scanned = step(states.ready(), readOf('PASS-0003'));
    const plain = step(scanned.state, answerOf(requestKey(scanned.cmds), 'ok', null), at(100));
    expect(plain.cmds).not.toContainEqual({ c: 'beat', beat: 'nod' });
    expect(plain.cmds).not.toContainEqual({ c: 'focus', target: 'card-heading' });
  });

  it('a refused approval does not nod', () => {
    const sent = step(held().state, { type: 'approve', pin: '482913' }, at(200));
    const refused = step(sent.state, answerOf(requestKey(sent.cmds), 'refused', 'voided'), at(300));
    expect(refused.cmds).not.toContainEqual({ c: 'beat', beat: 'nod' });
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
    expectSecretAbsent(JSON.stringify(wrong.state), '482913');
  });

  it.each(['stop', 'list', 'decide'] as const)(
    'a PIN that times out or loses the network lets nobody in (%s)',
    (mode) => {
      for (const error of ['timeout', 'network'] as const) {
        const sent = step(held(mode).state, { type: 'approve', pin: '482913' }, at(200));
        const lost = step(sent.state, { type: 'fail', key: requestKey(sent.cmds), error }, at(300));
        // Not the offline decision, not an unsure retry: the same hold, asking again.
        expect(hasCmd(lost.cmds, 'offline.decide')).toBe(false);
        expect(hasCmd(lost.cmds, 'unsure.keep')).toBe(false);
        expect(lost.state.unsure).toEqual([]);
        expect(lost.state.loop).toMatchObject({
          s: 'verdict',
          outcome: { kind: 'heads_up', reason: 'needs_approval' },
          pin: { unreachable: true },
        });
        expect(lost.state.recent.every((r) => r.outcome.kind !== 'ok')).toBe(true);
        expectSecretAbsent(JSON.stringify(lost.state), '482913');
      }
    },
  );

  it('offline there is nothing to check a PIN against: the hold stays and nothing is sent', () => {
    const offline = { ...held().state, online: false };
    const result = step(offline, { type: 'approve', pin: '482913' }, at(200));
    expect(result.cmds).toEqual([]);
    expect(result.state.loop).toMatchObject({
      s: 'verdict',
      outcome: { reason: 'needs_approval' },
      pin: { unreachable: true },
    });
  });

  it('a bare override cannot pass a needs_approval hold', () => {
    const result = step(held().state, { type: 'override', actionId: 'redeem' }, at(200));
    expect(result.cmds).toEqual([]);
    expect(result.state.loop).toMatchObject({ s: 'verdict' });
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
