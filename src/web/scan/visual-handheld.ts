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
