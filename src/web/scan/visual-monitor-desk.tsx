import { useEffect, useState } from 'react';
import type { ScanSession } from '../../shared/contracts/scan-session.ts';
import type { ScanLiveRow } from '../../shared/contracts/scan-setups.ts';
import { ScanApiError } from './api/errors.ts';
import type { ScanApi } from './api/scan-api.ts';
import { sessionFixture } from './boot/session.test-support.ts';
import { insideRow } from './inside/inside-fake.test-support.ts';
import { LiveScreen } from './live/live-screen.tsx';
import { fixtureOutcome } from './machine/fixture-data.test-support.ts';

export const MONITOR_DESK_CASES = ['off', 'signed-out', 'signed-in', 'manager', 'reset'] as const;
export type MonitorDeskCase = (typeof MONITOR_DESK_CASES)[number];

const SCAN = '01900000-0000-7000-8000-0000000000aa';
const ID = '01900000-0000-7000-8000-000000000001';

class DeskSocket {
  static readonly OPEN = 1;
  static last: DeskSocket | null = null;
  readyState = DeskSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() {
    DeskSocket.last = this;
    queueMicrotask(() => this.onopen?.());
  }
  send() {}
  close() {}
}

const staff = { id: ID, name: 'Mara Lopez', role: 'manager' as const };

function sessionOf(mode: MonitorDeskCase): ScanSession {
  const base = sessionFixture();
  const scanner = base.scanner;
  return {
    ...base,
    staff:
      mode === 'reset'
        ? { ...staff, role: 'desk' as const, pinResetRequired: true as const }
        : mode === 'signed-in' || mode === 'manager'
          ? staff
          : null,
    staffList: mode === 'signed-out' ? [staff] : null,
    scanner: scanner
      ? {
          ...scanner,
          deviceRole: 'monitor',
          settings: { ...scanner.settings, staffSignIn: true, deskActions: mode !== 'off' },
        }
      : null,
  };
}

const api = {
  inside: async () => ({
    places: [{ place: 'zone:gym', name: 'Gym floor', inNow: 4, capacity: 60, rev: 1 }],
    items: [0, 1, 2, 3].map((n) => insideRow(n, { photoUrl: null })),
    total: 4,
    nextCursor: null,
    asOf: Date.now(),
  }),
  override: async (body: { approval?: unknown; overrideOf: string }) => {
    if (!body.overrideOf.endsWith('0')) return fixtureOutcome('ok', null, { scanId: SCAN });
    if (!body.approval)
      return fixtureOutcome('heads_up', 'zone_not_included', {
        overridable: true,
        approvals: true,
      });
    throw new ScanApiError({ status: 400, code: 'PIN_INVALID', fields: { triesLeft: '2' } });
  },
  overrideNote: async () => undefined,
  undo: async () => fixtureOutcome('ok'),
  staffSignOut: async () => sessionFixture(),
  staffNewPin: async () => ({ pin: '497205', session: sessionFixture() }),
} as unknown as ScanApi;

/** The staff monitor beside the Desk actions setting: off, on and signed out, on and signed in. */
export function MonitorDeskVisual({ mode }: { mode: MonitorDeskCase }) {
  const [session] = useState(() => {
    window.WebSocket = DeskSocket as unknown as typeof WebSocket;
    return sessionOf(mode);
  });
  useEffect(() => {
    const names = ['Sam Rivera', 'Ana Costa', 'Lee Park'];
    const rows: ScanLiveRow[] = names.map((holder, i) => ({
      id: `${ID.slice(0, -2)}${20 + i}`,
      at: Date.now() - i * 70_000,
      scannerId: ID,
      scannerName: 'Front door',
      passId: ID,
      holder,
      photoUrl: null,
      kind: i === 1 ? 'heads_up' : 'ok',
      direction: i === 1 ? null : 'in',
      label: i === 1 ? 'Check required' : 'Checked in',
      presented: true,
      ...(i === 1 && (mode === 'signed-in' || mode === 'manager')
        ? { scanId: `${ID.slice(0, -2)}3${mode === 'manager' ? 0 : i}` }
        : {}),
    }));
    const timer = window.setTimeout(
      () => DeskSocket.last?.onmessage?.({ data: JSON.stringify({ cursor: 'c', rows }) }),
      40,
    );
    return () => window.clearTimeout(timer);
  }, [mode]);
  return <LiveScreen session={session} refetch={async () => undefined} api={api} />;
}
