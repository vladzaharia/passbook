/**
 * Builders for every machine state (AC 3.5) plus the card phases, the desk panel faces and `held`,
 * so the UI streams render without a store. Each carries a fixture `ScanDisplay` (DM section 8).
 * Server-shaped values parse with the contracts (fixtures.test.ts keeps that true).
 */
import { SCAN_TIMING } from '../timing.ts';
import {
  FIXTURE_NOW,
  fixtureCard,
  fixtureCounts,
  fixtureDraft,
  fixtureInput,
  fixtureOutcome,
} from './fixture-data.test-support.ts';
import type { CardLayer, Draft, Loop, ScanOutcome, ScanState, Unsure } from './types.ts';

const ID = '01900000-0000-7000-8000-000000000001';

export * from './fixture-data.test-support.ts';

export function fixtureState(over: Partial<ScanState> = {}): ScanState {
  return {
    loop: { s: 'ready', since: FIXTURE_NOW, hint: 0 },
    started: true,
    camera: 'live',
    overlay: null,
    block: null,
    posture: 'door',
    layout: 'handheld',
    armed: null,
    scope: { key: null, direction: 'in', operator: null },
    card: null,
    focused: true,
    online: true,
    unsure: [],
    queue: { pending: 0, oldestAt: null, conflicts: 0 },
    reader: { kind: 'none', lastAt: null, badLayout: 0 },
    undo: null,
    ignore: [],
    recent: [],
    counts: fixtureCounts(),
    prefs: { holdResults: false, sound: true },
    lastActivity: FIXTURE_NOW,
    ...over,
  };
}

const withLoop = (loop: Loop, over: Partial<ScanState> = {}) => fixtureState({ loop, ...over });
const layer = (phase: CardLayer['phase'], kind: CardLayer['kind']): CardLayer => ({
  phase,
  id: ID,
  kind,
});

/** One builder per state of AC 3.5. */
export const states = {
  start: () => fixtureState({ started: false, camera: 'off' }),
  ready: (hint: 0 | 1 | 2 | 3 = 0) => withLoop({ s: 'ready', since: FIXTURE_NOW, hint }),
  readerReady: () =>
    fixtureState({ reader: { kind: 'barcode', lastAt: null, badLayout: 0 }, camera: 'off' }),
  checking: (slow = false) =>
    withLoop({
      s: 'checking',
      input: fixtureInput(),
      key: fixtureInput().id,
      since: FIXTURE_NOW,
      slow,
      next: null,
    }),
  /** A different code arrives while a card is up: Checking... over the old card. */
  checkingOverCard: () =>
    withLoop(
      {
        s: 'checking',
        input: fixtureInput({ id: ID, sig: 'c:NEXT' }),
        key: ID,
        since: FIXTURE_NOW,
        slow: false,
        next: null,
      },
      { card: layer('up', 'result') },
    ),
  verdict: (
    kind: ScanOutcome['kind'] = 'ok',
    reason: ScanOutcome['reason'] = null,
    phase: CardLayer['phase'] = 'up',
  ) =>
    withLoop(
      {
        s: 'verdict',
        input: fixtureInput(),
        card: null,
        outcome: fixtureOutcome(kind, reason),
        since: FIXTURE_NOW,
        closeAt: kind === 'ok' ? FIXTURE_NOW + SCAN_TIMING.OK_HOLD : null,
        settleAt: null,
        openFrom: FIXTURE_NOW + SCAN_TIMING.NEXT_SCAN_AFTER_VERDICT,
        next: null,
      },
      { card: layer(phase, 'result') },
    ),
  /** Desk: the member panel, with no draft. */
  member: (band: ScanOutcome | null = null) =>
    withLoop(
      {
        s: 'member',
        input: fixtureInput(),
        card: fixtureCard(),
        since: FIXTURE_NOW,
        band,
        picker: null,
        held: null,
        locked: false,
      },
      { posture: 'desk', card: layer('up', 'panel') },
    ),
  /** Desk: the amount picker open. */
  picking: (draft: Draft = fixtureDraft()) =>
    withLoop(
      {
        s: 'member',
        input: fixtureInput(),
        card: fixtureCard(),
        since: FIXTURE_NOW,
        band: null,
        picker: draft,
        held: null,
        locked: false,
      },
      { posture: 'desk', card: layer('up', 'panel') },
    ),
  /** Desk: another pass was scanned while a draft is open (Switch or Keep editing). */
  held: () =>
    withLoop(
      {
        s: 'member',
        input: fixtureInput(),
        card: fixtureCard(),
        since: FIXTURE_NOW,
        band: null,
        picker: fixtureDraft(),
        held: fixtureInput({ id: ID, sig: 'c:OTHER', code: 'OTHER' }),
        locked: false,
      },
      { posture: 'desk', card: layer('up', 'panel') },
    ),
  reviewing: (draft: Draft = fixtureDraft({ actionId: 'redeem', amount: 10 })) =>
    withLoop(
      { s: 'reviewing', input: fixtureInput(), card: fixtureCard(), draft, held: null },
      { posture: 'desk', card: layer('up', 'panel') },
    ),
  /** The Manager PIN face: a locked action was tapped and `approvals` is on. */
  approval: () =>
    withLoop(
      {
        s: 'reviewing',
        input: fixtureInput(),
        card: fixtureCard(),
        draft: fixtureDraft({ actionId: 'redeem', amount: 10 }),
        held: null,
      },
      { posture: 'desk', card: layer('up', 'panel') },
    ),
  applying: (slow = false) =>
    withLoop(
      {
        s: 'applying',
        input: fixtureInput(),
        card: fixtureCard(),
        draft: fixtureDraft(),
        key: fixtureInput().id,
        since: FIXTURE_NOW,
        slow,
        next: null,
      },
      { posture: 'desk', card: layer('up', 'panel') },
    ),
  paused: (reason: 'idle' | 'hidden' | 'camera_lost' = 'idle') => withLoop({ s: 'paused', reason }),
  block: (block: NonNullable<ScanState['block']>) => fixtureState({ block }),
  unsure: (entry: Partial<Unsure> = {}) =>
    fixtureState({
      unsure: [
        {
          key: fixtureInput().id,
          sig: fixtureInput().sig,
          draft: fixtureDraft(),
          at: FIXTURE_NOW,
          state: 'retrying',
          ...entry,
        },
      ],
    }),
  armed: () => fixtureState({ armed: { actionId: 'add_stamp', amount: 1, sticky: true } }),
  overlay: (open: NonNullable<ScanState['overlay']>) => fixtureState({ overlay: open }),
  camera: (status: ScanState['camera']) => fixtureState({ camera: status }),
  /** Every card phase, for the rise, tuck and swap views. */
  cardPhase: (phase: CardLayer['phase'], kind: CardLayer['kind'] = 'result') =>
    fixtureState({ card: layer(phase, kind) }),
} as const;
