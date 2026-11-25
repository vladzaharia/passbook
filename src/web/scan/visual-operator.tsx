/** The operator workspace of the visual gallery (`?visual=1&surface=operator&case=idle|search|record|problems|empty|refusal`). */
import { type ReactNode, useEffect, useMemo } from 'react';
import type { ScanSession } from '../../shared/contracts/scan-session.ts';
import type { ScanApi } from './api/scan-api.ts';
import { sessionFixture } from './boot/session.test-support.ts';
import { WedgeFieldsContext } from './input/wedge-field.tsx';
import { createWedgeSource, WedgeFields } from './input/wedge-source.ts';
import { fixtureCounts, fixtureOutcome } from './machine/fixture-data.test-support.ts';
import { states } from './machine/fixtures.test-support.ts';
import { fakeClock, fakeDeps } from './machine/store.test-support.ts';
import { createScanStore } from './machine/store.ts';
import { ScanStoreContext } from './machine/use-scan-machine.ts';
import { OperatorWorkspace } from './operator/workspace/workspace.tsx';
import type { ScanRuntime } from './platform/runtime.ts';
import { FLOOR_CASES, floorApi } from './visual-operator-floor.ts';
import { historyPage, NOTES } from './visual-operator-history.ts';
import {
  GALLERY_NOW,
  mara,
  PASS_VIEW,
  RECORD_CASES,
  recordSession,
  recordState,
} from './visual-operator-record.ts';

export const OPERATOR_CASES = [
  'idle',
  'search',
  'record',
  'problems',
  'empty',
  'refusal',
  ...RECORD_CASES,
  ...FLOOR_CASES,
] as const;
export type OperatorCase = (typeof OPERATOR_CASES)[number];

const ID = '01900000-0000-7000-8000-000000000001';
const NOW = GALLERY_NOW;
const MIN = 60_000;
type Row = {
  name: string | null;
  tone: 'ok' | 'out' | 'no' | 'hu' | 'undone';
  where: string;
  reason?: string;
  min: number;
  staff?: string;
  pass?: number;
  method?: 'manual';
  undoable?: boolean;
  group?: number;
};
const ROWS: Row[] = [
  { name: 'Maya Okafor', tone: 'ok', where: 'Front desk', min: 1, undoable: true },
  { name: 'Leo Park', tone: 'no', where: 'Front desk', reason: 'guest_visits_used', min: 3 },
  { name: 'Sam Rivera', tone: 'out', where: 'Turnstile A', min: 5 },
  { name: 'Tomás Herrera', tone: 'hu', where: 'Pool gate', reason: 'capacity_full', min: 6 },
  { name: 'Priya Natarajan', tone: 'ok', where: 'Front desk', min: 8, method: 'manual' },
  { name: 'Kwame Okafor', tone: 'ok', where: 'Front desk', min: 9, group: 2 },
  { name: null, tone: 'no', where: 'Turnstile A', reason: 'not_found', min: 11 },
  { name: 'Aiko Tanaka', tone: 'ok', where: 'Studio door', min: 12 },
  { name: 'Ben Ortiz', tone: 'undone', where: 'Front desk', min: 14 },
  { name: 'Elif Demir', tone: 'ok', where: 'Pool gate', min: 16 },
  { name: 'Jonas Weber', tone: 'ok', where: 'Front desk', min: 17, staff: 'Ana R.', pass: 90 },
  {
    name: 'Jonas Weber',
    tone: 'no',
    where: 'Front desk',
    reason: 'already_done',
    min: 19,
    pass: 90,
  },
];

const activity = (rows: Row[]) =>
  rows.map((r, i) => ({
    id: `01900000-0000-7000-8000-0000000001${i.toString().padStart(2, '0')}`,
    at: NOW - r.min * MIN,
    deviceId: ID,
    deviceName: r.where,
    passId: r.name
      ? `01900000-0000-7000-8000-0000000002${(r.pass ?? i).toString().padStart(2, '0')}`
      : null,
    title: r.name,
    outcome:
      r.tone === 'undone'
        ? ('undone' as const)
        : r.tone === 'ok' || r.tone === 'out'
          ? ('ok' as const)
          : r.tone === 'no'
            ? ('refused' as const)
            : ('heads_up' as const),
    direction:
      r.tone === 'out'
        ? ('out' as const)
        : r.tone === 'no' || r.tone === 'hu'
          ? null
          : ('in' as const),
    scanId: `01900000-0000-7000-8000-0000000003${i.toString().padStart(2, '0')}`,
    reason: (r.reason ?? null) as never,
    staff: r.staff ?? null,
    method: r.method ?? ('wedge' as const),
    undoable: Boolean(r.undoable),
    groupSize: r.group ?? null,
  }));

const PEOPLE = [
  ['Mara Lopez', 'Day pass', 'm•••@g•••.com', 'out', 17],
  ['Maya Okafor', 'Member', 'm•••@o•••.ng', 'in', 1],
  ['Marcus Bell', 'Member', 'm•••@b•••.co', null, null],
  ['Marta Nowak', 'Guest', 'm•••@w•••.pl', 'in', 40],
  ['Omar Haddad', 'Member', 'o•••@h•••.com', null, null],
  ['Tamara Stein', 'Member', 't•••@s•••.de', 'out', 87],
] as const;

function apiFor(rows: Row[], scenario: string): ScanApi {
  return {
    ...floorApi(scenario),
    activity: async () => ({ items: activity(rows) }),
    lookup: async () => ({
      items: PEOPLE.map(([title, templateName, maskedEmail, doorState, min], i) => ({
        passId: `01900000-0000-7000-8000-0000000004${i.toString().padStart(2, '0')}`,
        title,
        subtitle: null,
        templateName,
        status: title === 'Omar Haddad' ? ('voided' as const) : ('active' as const),
        maskedEmail,
        photoUrl: null,
        doorState,
        lastScanAt: min ? NOW - min * MIN : null,
      })),
      more: false,
    }),
    resolve: async () =>
      fixtureOutcome('ready', 'choose', {
        card: {
          ...fixtureOutcome('ready').card,
          title: 'Mara Lopez',
          subtitle: '10-visit pack',
          display: mara(),
          passView: PASS_VIEW,
        } as never,
      }),
    history: async (_id: string, query: Parameters<ScanApi['history']>[1]) =>
      historyPage(scenario, query),
    notes: async () => ({ items: NOTES }),
    addNote: async (_id: string, body: { body: string }) => ({
      id: '01900000-0000-7000-8000-000000000899',
      at: NOW,
      body: body.body,
      by: 'Theo B.',
      own: true,
      edited: false,
    }),
    override: async () => fixtureOutcome('ok'),
    undo: async () => fixtureOutcome('ok'),
  } as unknown as ScanApi;
}

function sessionOf(): ScanSession {
  const base = sessionFixture({
    staff: { id: ID, name: 'Theo B.', role: 'desk' },
    templates: ['Members', 'Day passes', 'Guests', 'Staff'].map((name) => ({
      id: ID,
      name,
      style: 'storeCard',
      formats: [],
      actions: [],
    })),
    counts: {
      ...fixtureCounts(),
      today: 184,
      place: { name: 'Northside Gym', inNow: 42, capacity: 60 },
    },
  });
  const scanner = base.scanner;
  return {
    ...base,
    scanner: scanner
      ? {
          ...scanner,
          name: 'Front desk',
          orgName: 'Northside Gym',
          timeZone: 'America/New_York',
          settings: { ...scanner.settings, lookup: true, deskActions: true },
        }
      : null,
    workspace: {
      session: {
        id: ID,
        orgId: ID,
        orgName: 'Northside Gym',
        mode: 'live',
        name: 'Front desk',
        status: 'active',
        timeZone: 'America/New_York',
        window: { open: true, by: 'hours', opensAt: null, closesAt: NOW + 4 * 60 * MIN },
      },
      device: { effectiveSurface: 'operator' },
    },
  } as unknown as ScanSession;
}

const setNative = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

export function OperatorVisual({
  scenario,
  menu = null,
}: {
  scenario: OperatorCase;
  menu?: ReactNode;
}) {
  const session = useMemo(() => recordSession(sessionOf(), scenario), [scenario]);
  const api = useMemo(() => apiFor(scenario === 'empty' ? [] : ROWS, scenario), [scenario]);
  const store = useMemo(
    () =>
      createScanStore(
        fakeDeps(fakeClock(GALLERY_NOW)).deps,
        recordState(scenario) ?? states.ready(),
      ),
    [scenario],
  );
  const fields = useMemo(() => new WedgeFields(), []);
  const runtime = useMemo(
    () => ({ emit: () => undefined, checkIn: () => undefined, fields }) as unknown as ScanRuntime,
    [fields],
  );
  // The real wedge source, so a reader's burst is a scan here as it is on a device.
  useEffect(
    () =>
      createWedgeSource({
        fields,
        clock: {
          now: () => Date.now(),
          setTimeout: (fn, ms) => window.setTimeout(fn, ms),
          clearTimeout: (handle) => window.clearTimeout(handle as number),
        },
      }).start(() => undefined),
    [fields],
  );
  useEffect(() => {
    const timers: number[] = [];
    const later = (fn: () => void, ms: number) => timers.push(window.setTimeout(fn, ms));
    const field = () => document.querySelector<HTMLInputElement>('[data-operator-search]');
    if (scenario === 'search' || scenario === 'record')
      later(() => {
        const input = field();
        if (!input) return;
        input.focus();
        setNative(input, 'mar');
      }, 150);
    if (scenario === 'record')
      later(() => document.querySelector<HTMLElement>('[data-testid="op-result"]')?.click(), 900);
    if (scenario === 'problems')
      later(() => document.querySelector<HTMLElement>('#op-tab-problems')?.click(), 150);
    if (scenario === 'inside')
      later(() => document.querySelector<HTMLElement>('#op-tab-inside')?.click(), 150);
    if (scenario === 'rollcall-record')
      later(
        () =>
          document
            .querySelector<HTMLElement>('[data-testid="roll-call-row"] .op-row-main')
            ?.click(),
        700,
      );
    return () => {
      for (const t of timers) clearTimeout(t);
    };
  }, [scenario]);
  return (
    <ScanStoreContext.Provider value={store}>
      <WedgeFieldsContext.Provider value={fields}>
        <OperatorWorkspace
          api={api}
          runtime={runtime}
          session={session}
          counts={session.counts}
          branding={null}
          logoUrl={null}
          modeLabel="Operator"
          chips={null}
          testing={null}
          menu={menu}
          scanCard={null}
          announcement={null}
          onTitle={() => undefined}
          live={false}
        />
      </WedgeFieldsContext.Provider>
    </ScanStoreContext.Provider>
  );
}
