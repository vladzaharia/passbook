/** The operator record's states for the visual gallery: a verdict, a hold, a family, a photo slot, a read-only card. */
import type { Json } from '../../shared/contracts/common.ts';
import type { ScanDisplay } from '../../shared/contracts/scan-display.ts';
import type { ScanSession } from '../../shared/contracts/scan-session.ts';
import {
  FIXTURE_NOW,
  fixtureCard,
  fixtureDisplay,
  fixtureInput,
  fixtureOutcome,
} from './machine/fixture-data.test-support.ts';
import { fixtureState } from './machine/fixtures.test-support.ts';
import type { Loop, ScanOutcome, ScanState } from './machine/types.ts';
import { SCAN_TIMING } from './timing.ts';
import { VISUAL_PASS_JSON } from './visual-pass-fixtures.test-support.ts';

export const RECORD_CASES = ['ok', 'manager', 'family', 'photo', 'viewonly'] as const;

const ID = '01900000-0000-7000-8000-000000000001';
const ZONE = { kind: 'zone' as const, id: ID, name: 'Gym floor' };
const OCC = (state: 'in' | 'out') => ({
  place: ZONE,
  direction: state,
  auto: false,
  state,
  since: FIXTURE_NOW - 5 * 60_000,
  via: 'Front desk',
  stayMs: null,
  inNow: 42,
  capacity: 60,
  turnaround: null,
});

const PHOTO =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 72 72'><rect width='72' height='72' fill='%23c98f6b'/><circle cx='36' cy='28' r='13' fill='%23f1d2b8'/><path d='M10 72c2-20 14-27 26-27s24 7 26 27z' fill='%23324a5f'/></svg>";

function maya(
  over: Partial<ScanDisplay> = {},
  screen: ScanDisplay['screen'] = 'ok',
  photo = false,
): ScanDisplay {
  const base = fixtureDisplay(screen);
  return {
    ...base,
    identity: {
      holder: 'Maya Okafor',
      initials: 'MO',
      photo: photo ? { url: PHOTO, alt: 'Maya Okafor' } : null,
    },
    header: {
      icon: null,
      title: 'Maya Okafor',
      titleLines: 1,
      meta: 'Gold annual · Member since Mar 2024',
      chips: [
        { id: 'plan', text: 'Gold annual', tone: 'gold', icon: null },
        { id: 'tag', text: 'Basic tag', tone: 'neutral', icon: 'nfc' },
      ],
    },
    panels: [
      {
        id: 'membership',
        kind: 'membership',
        title: 'Membership',
        icon: null,
        tone: null,
        rows: [
          {
            type: 'columns',
            id: 'dates',
            size: 'normal',
            oneLine: false,
            items: [
              { label: 'Valid until', value: 'Mar 31, 2027' },
              { label: 'This month', value: '9 visits' },
            ],
          },
          {
            type: 'columns',
            id: 'plan',
            size: 'normal',
            oneLine: false,
            items: [
              { label: 'Last visit', value: 'Tue, Nov 17' },
              { label: 'Plan', value: 'All zones' },
            ],
          },
        ],
      },
    ],
    ...over,
    notes: { staff: null, refused: null },
  } as ScanDisplay;
}

const verdict = (outcome: ScanOutcome, recent = false): ScanState => {
  const loop: Loop = {
    s: 'verdict',
    input: fixtureInput({ passId: ID }),
    card: null,
    outcome,
    since: FIXTURE_NOW,
    closeAt: null,
    settleAt: null,
    openFrom: FIXTURE_NOW + SCAN_TIMING.NEXT_SCAN_AFTER_VERDICT,
    next: null,
  };
  return fixtureState({
    loop,
    posture: 'desk',
    card: { phase: 'up', id: ID, kind: 'result' },
    recent: recent ? [{ scanId: ID, at: FIXTURE_NOW, outcome, undoable: true }] : [],
  });
};

export const PASS_VIEW = {
  passJson: (VISUAL_PASS_JSON.membership ?? { formatVersion: 1 }) as unknown as Json,
  assetBaseUrl: '/api/v1/scan/passes/x/assets/',
  assetGrant: 'g',
  assetNames: [],
};
const checkIn = { id: 'check_in', label: 'Check in', kind: 'check_in' as const };
const bundle = { id: ID, name: 'Okafor family', size: 3, checkedIn: 1 };

export function recordState(scenario: string): ScanState | null {
  const at = FIXTURE_NOW;
  switch (scenario) {
    case 'ok':
      return verdict(
        fixtureOutcome('ok', null, {
          action: checkIn,
          at,
          occupancy: OCC('in'),
          display: maya({}, 'ok', true),
          card: null,
          undoUntil: Date.now() + 600_000,
        }),
        true,
      );
    case 'refusal':
      return verdict(
        fixtureOutcome('refused', 'guest_visits_used', {
          display: maya({}, 'refused'),
          occupancy: OCC('out'),
          access: {
            plan: { id: 'g', label: 'Guest pass', kind: 'guest' },
            zone: null,
            closesAt: null,
            nextOpenAt: null,
            visits: { used: 1, limit: 1 },
            visit: false,
            timeZone: 'UTC',
          },
          at,
        }),
      );
    case 'manager':
      return verdict(
        fixtureOutcome('refused', 'needs_approval', {
          action: checkIn,
          approvals: true,
          overridable: true,
          display: maya({}, 'refused'),
          occupancy: OCC('out'),
          at,
        }),
      );
    case 'family':
      return verdict(
        fixtureOutcome('ok', null, {
          action: checkIn,
          at,
          bundle,
          occupancy: OCC('in'),
          display: maya(),
          undoUntil: Date.now() + 600_000,
        }),
        true,
      );
    case 'photo':
      return verdict(
        fixtureOutcome('ok', null, { action: checkIn, at, occupancy: OCC('in'), display: maya() }),
      );
    case 'viewonly': {
      const locked = fixtureCard().actions.map((a) => ({
        ...a,
        available: false,
        lock: 'role' as const,
      }));
      return fixtureState({
        posture: 'desk',
        loop: {
          s: 'member',
          input: fixtureInput({ passId: ID }),
          card: fixtureCard({
            title: 'Maya Okafor',
            actions: locked,
            display: maya({}, 'ready'),
            door: { state: 'out' },
            passView: PASS_VIEW,
          }),
          since: FIXTURE_NOW,
          band: null,
          picker: null,
          held: null,
          locked: false,
        },
        card: { phase: 'up', id: ID, kind: 'panel' },
      });
    }
    default:
      return null;
  }
}

/** The staff role and photo rights each state needs: everything is Desk, a manager's PIN aside. */
export function recordSession(base: ScanSession, _scenario: string): ScanSession {
  const scanner = base.scanner;
  if (!scanner) return base;
  const settings = { ...scanner.settings, staffSignIn: true };
  return {
    ...base,
    staff: { id: ID, name: 'Theo B.', role: 'desk' },
    staffList: [{ id: '01900000-0000-7000-8000-0000000000b2', name: 'Ana R.', role: 'manager' }],
    scanner: { ...scanner, settings },
  } as ScanSession;
}

/** The search case's person: a pack holder with a visit left. */
export const mara = (): ScanDisplay => {
  const d = maya({}, 'ready');
  return {
    ...d,
    identity: { holder: 'Mara Lopez', initials: 'ML', photo: null },
    header: {
      ...d.header,
      title: 'Mara Lopez',
      meta: '10-visit pack',
      chips: [{ id: 'plan', text: 'Day pass', tone: 'teal', icon: null }],
    },
  };
};
