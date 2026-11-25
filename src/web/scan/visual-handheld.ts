import type { ScanReason } from '../../shared/contracts/scan.ts';
import { FIXTURE_NOW, fixtureOutcome } from './machine/fixture-data.test-support.ts';
import type { Recent, ScanOutcome } from './machine/types.ts';
import type { Tint } from './ui/verdict-tint.tsx';
import type { SCAN_VISUAL_CASES } from './visual-cases.test-support.ts';

const ID = '01900000-0000-7000-8000-000000000001';

/** `?kind=heads_up` or `?kind=refused` (with `?reason=`) shows the pass as a stop; `?sheet=pass|recent` opens the sheet. */
export function withKind(selected: (typeof SCAN_VISUAL_CASES)[number], params: URLSearchParams) {
  const kind = params.get('kind');
  const o = selected.outcome;
  if (kind === 'system')
    return fixtureOutcome('system', 'network', { card: null, display: null, action: null });
  if (kind !== 'heads_up' && kind !== 'refused') return o;
  const d = o.display;
  const reason = (params.get('reason') ??
    (kind === 'refused' ? 'voided' : 'already_done')) as ScanReason;
  return fixtureOutcome(kind, reason, {
    card: o.card,
    template: o.template,
    action: kind === 'heads_up' ? o.action : null,
    previous: {
      scanId: ID,
      at: FIXTURE_NOW - 12 * 60_000,
      scannerName: 'Side door',
      staffName: null,
      actionLabel: 'Checked in',
      override: false,
    },
    ...(d
      ? {
          display: {
            ...d,
            screen: kind,
            panels: kind === 'refused' ? [] : d.panels,
            notes: {
              staff: kind === 'heads_up' ? 'Check ID before letting in again.' : null,
              refused: null,
            },
          },
        }
      : {}),
  });
}

export const TINT: Partial<Record<ScanOutcome['kind'], Tint>> = {
  ok: 'green',
  heads_up: 'amber',
  refused: 'red',
  system: 'slate',
};

/** The device's recent scans; the first is the scan on screen when it is a check-in. */
export const recentRows = (current: boolean): Recent[] =>
  [
    ...(current ? [{ name: 'Priya N. Shah', kind: 'ok' as const, ago: 0 }] : []),
    { name: 'Ben Okafor', kind: 'ok' as const, ago: 1 },
    { name: 'Anna Park', kind: 'ok' as const, ago: 3 },
    { name: 'Sam Rivera', kind: 'heads_up' as const, ago: 7 },
    { name: 'Unknown code', kind: 'refused' as const, ago: 9 },
  ].map(({ name, kind, ago }, i) => {
    const outcome = fixtureOutcome(kind, kind === 'ok' ? null : 'already_done', {
      scanId: current && i === 0 ? ID : `${ID.slice(0, -2)}${20 + i}`,
      at: FIXTURE_NOW - ago * 60_000,
    });
    return {
      scanId: outcome.scanId,
      at: FIXTURE_NOW - ago * 60_000,
      outcome: {
        ...outcome,
        display: outcome.display && {
          ...outcome.display,
          identity: { ...outcome.display.identity, holder: name },
        },
      },
      undoable: i === 0,
    };
  });

/** The card the sheet fetches: today's scans of the pass at two doors, and a bound tag. */
export function withCard(o: ScanOutcome) {
  if (!o.card) return { outcome: o, card: null };
  const scan = (n: number, ago: number, label: string, scannerName: string) => ({
    scanId: `${ID.slice(0, -2)}${40 + n}`,
    at: FIXTURE_NOW - ago * 60_000,
    actionLabel: label,
    outcome: 'ok' as const,
    scannerName,
    undoable: false,
  });
  const card = {
    ...o.card,
    lastScans: [scan(1, 52, 'Checked in', 'Side door')],
    tag: {
      hint: '4F2A',
      assurance: 'basic' as const,
      scope: 'pass' as const,
      typeName: 'Wristband',
    },
  };
  return { outcome: { ...o, card }, card };
}

/** `?sun=1` is sunlight mode, `?hand=left` the mirrored thumb row. Nothing else is read. */
export function lookFromUrl(params = new URLSearchParams(location.search)) {
  return { sun: params.get('sun') === '1', leftHand: params.get('hand') === 'left' };
}

/** `?group=chip` offers Check in all; `?group=partial` shows a group with a refused member. */
export function withGroup(o: ScanOutcome, mode: string | null): ScanOutcome {
  if (mode !== 'chip' && mode !== 'partial') return o;
  const bundle = { id: ID, name: 'Chen family', size: 4, checkedIn: 1 };
  if (mode === 'chip') return { ...o, bundle };
  const m = (name: string, state: 'done' | 'already' | 'refused', reason: ScanReason | null) => ({
    name,
    state,
    reason,
  });
  return {
    ...o,
    bundle,
    group: {
      total: 4,
      done: 2,
      already: 1,
      refused: 1,
      members: [
        m('Taylor Chen', 'done', null),
        m('Jo Chen', 'done', null),
        m('Sam Chen', 'already', 'already_done'),
        m('Kid Chen', 'refused', 'voided'),
      ],
    },
  };
}
