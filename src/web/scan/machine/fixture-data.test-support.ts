/** Server-shaped fixtures: counts, a rendered display per screen, the card, outcomes, inputs, drafts. */
import type { ScanDisplay } from '../../../shared/contracts/scan-display.ts';
import type { ScanInput } from '../input/types.ts';
import { SCAN_TIMING } from '../timing.ts';
import type { Card, Counts, Draft, ScanOutcome } from './types.ts';

export const FIXTURE_NOW = Date.UTC(2026, 10, 5, 18, 0, 0);
const ID = '01900000-0000-7000-8000-000000000001';

export const fixtureCounts = (over: Partial<Counts> = {}): Counts => ({
  today: 42,
  event: { arrived: 42, inside: 40, expected: 120, capacity: 150 },
  asOf: FIXTURE_NOW,
  configRev: 1,
  ...over,
});

/** A rendered display per screen: header, chips and one panel (a progress row on the card). */
export function fixtureDisplay(screen: ScanDisplay['screen'] = 'ok'): ScanDisplay {
  return {
    v: 1,
    screen,
    templateVersion: 'v1',
    variant: null,
    identity: { holder: 'Anna Popescu', initials: 'AP', photo: null },
    header: {
      icon: 'star',
      title: 'Anna Popescu',
      titleLines: 1,
      meta: 'Gold member',
      chips: [{ id: 'vip', text: 'VIP', tone: 'gold', icon: null }],
    },
    panels:
      screen === 'refused'
        ? []
        : [
            {
              id: 'main',
              kind: 'loyalty',
              title: 'Coffee card',
              icon: null,
              tone: null,
              rows: [
                {
                  type: 'progress',
                  id: 'stamps',
                  value: 6,
                  goal: 10,
                  before: 5,
                  style: 'stamps',
                  icon: null,
                  rewards: 0,
                  caption: '4 more for a free coffee',
                },
              ],
            },
          ],
    notes: { staff: screen === 'heads_up' ? 'Check ID.' : null, refused: null },
  };
}

export function fixtureCard(over: Partial<Card> = {}): Card {
  return {
    passId: ID,
    version: 1,
    mode: 'live',
    title: 'Anna Popescu',
    subtitle: 'Gold member',
    template: { id: ID, name: 'Coffee card', style: 'storeCard' },
    status: 'active',
    validFrom: null,
    validUntil: null,
    flags: [],
    values: [
      { input: 'stamps', label: 'Stamps', before: 5, after: null, goal: 10, format: 'number' },
    ],
    actions: [
      {
        id: 'add_stamp',
        label: 'Add stamp',
        kind: 'add',
        available: true,
        lock: null,
        reason: null,
        amount: { fixed: 1 },
        confirm: false,
        confirmAbove: null,
        cooldownRemainingMs: null,
        armable: 'sticky',
        rewardLabel: null,
      },
      {
        id: 'redeem',
        label: 'Redeem reward',
        kind: 'take',
        available: false,
        lock: 'approval',
        reason: 'needs_approval',
        amount: { max: 10, presets: [10], default: 10 },
        confirm: true,
        confirmAbove: null,
        cooldownRemainingMs: null,
        armable: null,
        rewardLabel: 'Free coffee',
      },
    ],
    display: fixtureDisplay('ready'),
    lastScans: [],
    bundle: null,
    door: null,
    passView: {
      passJson: { formatVersion: 1 },
      assetBaseUrl: '/api/v1/scan/passes/x/assets/',
      assetGrant: 'g',
      assetNames: [],
    },
    ...over,
  };
}

export function fixtureOutcome(
  kind: ScanOutcome['kind'] = 'ok',
  reason: ScanOutcome['reason'] = null,
  over: Partial<ScanOutcome> = {},
): ScanOutcome {
  const server = kind === 'ok' || kind === 'heads_up' || kind === 'refused' || kind === 'ready';
  const screen = kind === 'heads_up' ? 'heads_up' : kind === 'refused' ? 'refused' : 'ok';
  return {
    scanId: server ? ID : null,
    kind,
    reason,
    replay: false,
    action: kind === 'ok' ? { id: 'add_stamp', label: 'Add stamp', kind: 'add' } : null,
    card: kind === 'ready' ? fixtureCard() : null,
    previous: null,
    template: { name: 'Coffee card', style: 'storeCard' },
    at: FIXTURE_NOW,
    cooldownRemainingMs: null,
    value: null,
    flags: [],
    overridable: kind === 'heads_up',
    approvals: true,
    group: null,
    counts: fixtureCounts(),
    milestone: null,
    undoUntil: kind === 'ok' ? FIXTURE_NOW + SCAN_TIMING.UNDO_WINDOW : null,
    display: server && kind !== 'ready' ? fixtureDisplay(screen) : null,
    ...over,
  };
}

export const fixtureInput = (over: Partial<ScanInput> = {}): ScanInput => ({
  method: 'camera',
  code: 'PB-7QK2-M9XT',
  format: 'qr',
  id: '01900000-0000-7000-8000-0000000000aa',
  at: FIXTURE_NOW,
  sig: 'c:PB-7QK2-M9XT',
  ...over,
});

export const fixtureDraft = (over: Partial<Draft> = {}): Draft => ({
  actionId: 'add_stamp',
  amount: 1,
  ...over,
});
