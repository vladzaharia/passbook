import { describe, expect, it } from 'vitest';
import {
  ScanCardSchema,
  ScanCountsSchema,
  ScanOutcomeSchema,
} from '../../../shared/contracts/scan.ts';
import { ScanDisplaySchema } from '../../../shared/contracts/scan-display.ts';
import { SCAN_TIMING } from '../timing.ts';
import {
  fixtureCard,
  fixtureCounts,
  fixtureDisplay,
  fixtureOutcome,
  fixtureState,
  states,
} from './fixtures.test-support.ts';
import type { Loop } from './types.ts';

describe('scan fixtures', () => {
  it('parse with the contracts', () => {
    expect(ScanCardSchema.safeParse(fixtureCard()).success).toBe(true);
    expect(ScanCountsSchema.safeParse(fixtureCounts()).success).toBe(true);
    for (const screen of ['ready', 'ok', 'heads_up', 'refused'] as const)
      expect(ScanDisplaySchema.safeParse(fixtureDisplay(screen)).success, screen).toBe(true);
    for (const kind of ['ok', 'heads_up', 'refused', 'ready'] as const) {
      const parsed = ScanOutcomeSchema.safeParse(
        fixtureOutcome(
          kind,
          kind === 'heads_up' ? 'already_done' : kind === 'refused' ? 'voided' : null,
        ),
      );
      expect(parsed.success, kind).toBe(true);
    }
  });

  it('cover every loop state, every card phase, the desk faces and held', () => {
    const loops = new Set<Loop['s']>();
    for (const build of [
      states.ready(),
      states.checking(),
      states.verdict('ok'),
      states.member(),
      states.reviewing(),
      states.applying(),
      states.paused(),
    ])
      loops.add(build.loop.s);
    expect([...loops].sort()).toEqual([
      'applying',
      'checking',
      'member',
      'paused',
      'ready',
      'reviewing',
      'verdict',
    ]);
    for (const phase of ['rising', 'up', 'tucking'] as const)
      expect(states.cardPhase(phase).card?.phase).toBe(phase);
    expect(states.cardPhase('up', 'panel').card?.kind).toBe('panel');
    expect(states.held().loop).toMatchObject({ s: 'member', held: { sig: 'c:OTHER' } });
    expect(states.picking().loop).toMatchObject({ s: 'member', picker: { actionId: 'add_stamp' } });
    expect(states.block('staff').block).toBe('staff');
    expect(states.checkingOverCard().card?.phase).toBe('up');
  });

  it('a verdict opens a different code at T0 + 350', () => {
    const s = states.verdict('ok');
    expect(s.loop.s === 'verdict' && s.loop.openFrom - s.loop.since).toBe(
      SCAN_TIMING.NEXT_SCAN_AFTER_VERDICT,
    );
    expect(SCAN_TIMING.NEXT_SCAN_AFTER_VERDICT).toBe(350);
  });

  it('builds a default state with no card layer and the door posture', () => {
    expect(fixtureState()).toMatchObject({ posture: 'door', card: null, block: null });
  });
});

describe('SCAN_TIMING', () => {
  it('holds the card layer constants', () => {
    expect(SCAN_TIMING).toMatchObject({
      BEAT_DELAY: 150,
      BEAT_MAX: 550,
      NEXT_SCAN_AFTER_VERDICT: 350,
      CARD_RISE: 380,
      CARD_TUCK: 180,
      CARD_SWAP_TUCK: 150,
      DESK_DIM: 200,
      COMMIT_ARM: 260,
    });
  });
});
