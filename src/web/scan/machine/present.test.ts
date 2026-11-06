import { describe, expect, it } from 'vitest';
import { SCAN_TIMING } from '../timing.ts';
import { fixtureCard, fixtureOutcome, states } from './fixtures.test-support.ts';
import { presentOutcome, viewOf } from './present.ts';
import type { ScanOutcome } from './types.ts';

const OPTS = { holdResults: false };
const system = (reason: NonNullable<ScanOutcome['reason']>) =>
  fixtureOutcome('system', reason, { local: true });

describe('presentOutcome: kind x posture', () => {
  it('ok', () => {
    const door = presentOutcome(fixtureOutcome('ok'), 'door', OPTS);
    expect(door).toMatchObject({
      tint: 'green',
      hold: SCAN_TIMING.OK_HOLD,
      dim: false,
      tone: 'ok',
      region: 'status',
      card: { kind: 'result', rise: true },
      dock: { primary: null, secondary: 'undo', focus: null },
    });
    const desk = presentOutcome(fixtureOutcome('ok'), 'desk', OPTS);
    expect(desk).toMatchObject({ tint: 'green', hold: SCAN_TIMING.OK_HOLD });
    expect(desk.dock.primary).toBe('done');
  });

  it('ok with a reward promotes the take action to the dock primary', () => {
    const card = fixtureCard({
      values: [
        { input: 'stamps', label: 'Stamps', before: 9, after: 10, goal: 10, format: 'number' },
      ],
      actions: fixtureCard().actions.map((a) =>
        a.id === 'redeem' ? { ...a, available: true, lock: null, reason: null } : a,
      ),
    });
    const view = presentOutcome(fixtureOutcome('ok', null, { card }), 'desk', OPTS);
    expect(view.dock.primary).toBe('redeem');
    const notYet = fixtureCard({
      values: [
        { input: 'stamps', label: 'Stamps', before: 5, after: 6, goal: 10, format: 'number' },
      ],
    });
    expect(
      presentOutcome(fixtureOutcome('ok', null, { card: notYet }), 'desk', OPTS).dock.primary,
    ).toBe('done');
  });

  it('a milestone plays the reward tone and the fan', () => {
    const view = presentOutcome(fixtureOutcome('ok', null, { milestone: 'all_in' }), 'door', OPTS);
    expect(view.tone).toBe('reward');
    expect(view.beat).toBe('fan');
  });

  it('heads_up holds until a tap and focuses Done, at the door and the desk', () => {
    for (const posture of ['door', 'desk'] as const) {
      const view = presentOutcome(fixtureOutcome('heads_up', 'already_done'), posture, OPTS);
      expect(view).toMatchObject({
        tint: 'amber',
        hold: null,
        tone: 'heads_up',
        beat: 'wrist',
        dock: { primary: 'done', focus: 'done' },
      });
    }
  });

  it('needs_approval offers the Manager PIN only when approvals are on', () => {
    const on = presentOutcome(fixtureOutcome('heads_up', 'needs_approval'), 'desk', OPTS);
    expect(on.dock.primary).toBe('approve');
    const off = presentOutcome(
      fixtureOutcome('heads_up', 'needs_approval', { approvals: false }),
      'desk',
      OPTS,
    );
    expect(off.dock.primary).toBe('done');
  });

  it('refused holds 3 s at the door, ambiguous and the desk until a tap', () => {
    expect(presentOutcome(fixtureOutcome('refused', 'voided'), 'door', OPTS)).toMatchObject({
      tint: 'red',
      hold: SCAN_TIMING.REFUSED_HOLD,
      region: 'alert',
      tone: 'refused',
      beat: 'shake',
    });
    expect(presentOutcome(fixtureOutcome('refused', 'ambiguous'), 'door', OPTS).hold).toBeNull();
    expect(presentOutcome(fixtureOutcome('refused', 'voided'), 'desk', OPTS).hold).toBeNull();
  });

  it('system is slate, an alert, with Done focused; the beat follows the reason', () => {
    const net = presentOutcome(system('network'), 'door', OPTS);
    expect(net).toMatchObject({
      tint: 'slate',
      region: 'alert',
      tone: 'system',
      beat: 'cloud',
      hold: null,
      dock: { primary: 'done', focus: 'done' },
    });
    expect(presentOutcome(system('network'), 'desk', OPTS).hold).toBe(SCAN_TIMING.OK_HOLD);
    expect(presentOutcome(system('server'), 'door', OPTS).beat).toBe('plug');
    expect(
      presentOutcome(system('rate_limited'), 'door', { ...OPTS, retryAfterMs: 4000 }),
    ).toMatchObject({
      beat: 'wait',
      hold: 4000,
    });
  });

  it('queued is green with the stash beat', () => {
    const view = presentOutcome(
      fixtureOutcome('queued', 'saved_offline', { local: true }),
      'door',
      OPTS,
    );
    expect(view).toMatchObject({ tint: 'green', tone: 'ok', beat: 'stash' });
  });

  it('ready opens a panel with no tint, a dimmed camera and the commit pair', () => {
    const view = presentOutcome(fixtureOutcome('ready'), 'desk', OPTS);
    expect(view).toMatchObject({
      tint: 'none',
      dim: true,
      hold: null,
      tone: null,
      card: { kind: 'panel', rise: true },
      dock: { primary: 'commit', secondary: 'cancel' },
    });
  });

  it('holdResults holds every verdict', () => {
    for (const kind of ['ok', 'refused'] as const)
      for (const posture of ['door', 'desk'] as const)
        expect(
          presentOutcome(fixtureOutcome(kind, kind === 'refused' ? 'voided' : null), posture, {
            holdResults: true,
          }).hold,
        ).toBeNull();
  });

  it('an unknown reason renders as a generic refusal view', () => {
    const view = presentOutcome(
      fixtureOutcome('refused', 'from_the_future' as never),
      'door',
      OPTS,
    );
    expect(view.tint).toBe('red');
    expect(view.announcement).toBeTruthy();
  });
});

describe('viewOf: the whole state', () => {
  it('ready and checking have no card; verdict shows the outcome; panels dim the camera', () => {
    expect(viewOf(states.ready()).tint).toBe('none');
    expect(viewOf(states.checking(true)).buddy.pose).toBe('rummage');
    expect(viewOf(states.verdict('refused', 'voided')).tint).toBe('red');
    const panel = viewOf(states.picking());
    expect(panel).toMatchObject({ dim: true, dock: { primary: 'commit', secondary: 'cancel' } });
    expect(viewOf(states.reviewing()).dock.secondary).toBe('back');
  });

  it('the buddy view carries the card direction and the pose', () => {
    expect(viewOf(states.cardPhase('rising')).buddy.card).toBe('in');
    expect(viewOf(states.cardPhase('tucking')).buddy.card).toBe('out');
    expect(viewOf(states.verdict('refused', 'voided')).buddy).toMatchObject({
      mood: 'sad',
    });
    expect(viewOf(states.verdict('system', 'network')).buddy.pose).toBe('sorry');
  });
});
