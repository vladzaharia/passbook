import { useEffect, useState } from 'react';
import type { ScanSession } from '../../shared/contracts/scan-session.ts';
import type { ScanLiveRow } from '../../shared/contracts/scan-setups.ts';
import { PHONE, useMediaQuery } from '../lib/media.ts';
import type { ScanApi } from './api/scan-api.ts';
import { sessionFixture } from './boot/session.test-support.ts';
import { CustomerDisplayPage } from './customer-display.tsx';
import { HardwareVisual } from './hardware/visual-hardware.tsx';
import { LiveScreen } from './live/live-screen.tsx';
import { FIXTURE_NOW, fixtureOutcome } from './machine/fixture-data.test-support.ts';
import { ScanPreviewScreen } from './preview-screen.tsx';
import { type PassInspection, PassInspector } from './result/pass-inspector.tsx';
import { RoleUnlock } from './role/unlock-sheet.tsx';
import { MenuTrigger } from './ui/capsule.tsx';
import { CountChip } from './ui/chips.tsx';
import { ACCESS_SCENARIOS, AccessVisual } from './visual-access.tsx';
import { SCAN_VISUAL_CASES } from './visual-cases.test-support.ts';
import { ClosedVisual } from './visual-closed.tsx';
import { DOOR_CASES, DoorVisual } from './visual-door.tsx';
import { lookFromUrl, recentRows, TINT, withCard, withGroup, withKind } from './visual-handheld.ts';
import { VisualLookup } from './visual-lookup.tsx';
import { MONITOR_DESK_CASES, MonitorDeskVisual } from './visual-monitor-desk.tsx';
import { OFFLINE_SCENARIOS, OfflineVisual } from './visual-offline.tsx';
import { OPERATOR_CASES, OperatorVisual } from './visual-operator.tsx';
import { PinResetVisual, StaffVisual } from './visual-staff.tsx';
import { TAG_SCENARIOS, TagVisual } from './visual-tags.tsx';
import { TRAY_CASES, TrayVisual } from './visual-trays.tsx';
import './visual-gallery.css';

const ID = '01900000-0000-7000-8000-000000000001';
const BRANDING = {
  accent: '#0f766e',
  logo: { sha: 'a'.repeat(64), w: 480, h: 150 },
};

class VisualSocket {
  static readonly OPEN = 1;
  static instances: VisualSocket[] = [];
  readyState = VisualSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    VisualSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send() {}
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
  publish(row: ScanLiveRow) {
    this.onmessage?.({ data: JSON.stringify({ cursor: row.id, rows: [row] }) });
  }
  snapshot(rows: ScanLiveRow[], places: unknown[]) {
    this.onmessage?.({ data: JSON.stringify({ cursor: rows[0]?.id ?? null, rows, places }) });
  }
}

function sessionFor(surface: string): ScanSession {
  const base = sessionFixture({ branding: BRANDING });
  const scanner = base.scanner ? { ...base.scanner, orgName: 'Northwind Live' } : null;
  return {
    ...base,
    scanner: scanner && surface === 'customer' ? { ...scanner, deviceRole: 'customer' } : scanner,
  };
}

type Face = { kind: ScanLiveRow['kind']; label: string; headline: string };
const OK_FACE: Face = { kind: 'ok', label: 'Checked in', headline: 'Checked in' };
const LIVE_FACE: Record<string, Face> = {
  out: { kind: 'ok', label: 'Checked out', headline: 'See you soon' },
  refused: { kind: 'refused', label: 'Not accepted', headline: 'Please see the desk' },
  heads_up: { kind: 'heads_up', label: 'One more check', headline: 'Please see staff' },
  ready: { kind: 'ready', label: 'Checking pass', headline: 'Checking pass' },
  undo: { kind: 'undo', label: 'Entry undone', headline: 'Entry undone' },
};

function LiveVisual({ session, status }: { session: ScanSession; status: string }) {
  const [installed] = useState(() => {
    VisualSocket.instances = [];
    window.WebSocket = VisualSocket as unknown as typeof WebSocket;
    return true;
  });
  const face = LIVE_FACE[status] ?? OK_FACE;
  useEffect(() => {
    if (!installed) return;
    const id = `${ID.slice(0, -1)}2`;
    const row: ScanLiveRow = {
      id,
      // The customer screen drops a row after 4 to 6 s; a gallery frame must outlast the capture.
      at: Date.now() + 3_600_000,
      scannerId: ID,
      scannerName: 'West entrance',
      passId: ID,
      holder: 'Private pass holder',
      photoUrl: null,
      kind: face.kind,
      direction: status === 'out' ? 'out' : 'in',
      label: face.label,
      presented: true,
      customer: {
        v: 1 as const,
        screen: face.kind === 'refused' ? ('see_desk' as const) : ('ok' as const),
        ref: id,
        at: Date.now(),
        where: '',
        band: { headline: face.headline, sub: null },
        greet: face.kind === 'ok' ? 'Hi, Sam' : null,
        chips: [],
        panel: null,
        lines: [],
        milestone: null,
        test: false,
      },
    };
    const timer = window.setTimeout(() => VisualSocket.instances.at(-1)?.publish(row), 40);
    return () => window.clearTimeout(timer);
  }, [installed, status, face]);
  return (
    <>
      <LiveScreen session={session} refetch={async () => undefined} />
      {session.scanner?.deviceRole === 'customer' ? (
        <RoleUnlock api={{} as ScanApi} refetch={async () => undefined} />
      ) : null}
    </>
  );
}

/** The wall monitor with a busy hall: `count` and `capacity` come from the URL. */
function MonitorVisual({ count, capacity }: { count: number; capacity: number | null }) {
  const [session] = useState(() => {
    VisualSocket.instances = [];
    window.WebSocket = VisualSocket as unknown as typeof WebSocket;
    return sessionFor('monitor');
  });
  useEffect(() => {
    const names = ['Sam Rivera', 'Member M-006', 'Ana Costa', 'Lee Park', 'Mo Haddad'];
    const rows: ScanLiveRow[] = names.map((holder, i) => ({
      id: `${ID.slice(0, -2)}${10 + i}`,
      at: Date.now() - i * 70_000,
      scannerId: ID,
      scannerName: 'West entrance',
      passId: ID,
      holder,
      photoUrl: null,
      kind: i === 3 ? 'refused' : 'ok',
      direction: i === 1 ? 'out' : 'in',
      label: i === 3 ? 'Not accepted' : i === 1 ? 'Checked out' : 'Checked in',
      presented: true,
    }));
    const places = [
      { place: 'zone:main', name: 'Main hall', inNow: count, capacity, rev: 1 },
      { place: 'zone:wall', name: 'Climbing wall', inNow: 12, capacity: 30, rev: 1 },
    ];
    const timer = window.setTimeout(
      () => VisualSocket.instances.at(-1)?.snapshot(rows, places),
      40,
    );
    return () => window.clearTimeout(timer);
  }, [count, capacity]);
  return <LiveScreen session={session} refetch={async () => undefined} />;
}

function DuoVisual({ status }: { status: string }) {
  useState(() => {
    const selected = ['ready', 'checking', 'accepted', 'checkedOut', 'rejected', 'failed'].includes(
      status,
    )
      ? status
      : 'accepted';
    window.PassBookCustomerDisplay = {
      status: selected as NonNullable<typeof window.PassBookCustomerDisplay>['status'],
      revision: 1,
      branding: { name: 'Northwind Live', accent: BRANDING.accent, logoSha: BRANDING.logo.sha },
      onmessage: null,
    };
  });
  return <CustomerDisplayPage />;
}

function ScanResultVisual({
  surface,
  selected,
  phase,
}: {
  surface: string;
  selected: (typeof SCAN_VISUAL_CASES)[number];
  phase: 'up' | 'rising';
}) {
  const params = new URLSearchParams(location.search);
  const sheet = params.get('sheet');
  const handheld = useMediaQuery(PHONE) && surface !== 'operator';
  const [inspection, setInspection] = useState<PassInspection | null>(
    sheet === 'pass' || sheet === 'recent'
      ? { ...withCard(withKind(selected, params)), live: true, tab: sheet }
      : null,
  );
  const [looking, setLooking] = useState(false);
  const [api] = useState(() => ({ resolve: async () => selected.outcome }) as unknown as ScanApi);
  const outcome = withGroup(withKind(selected, params), params.get('group'));
  return (
    <ScanPreviewScreen
      outcome={outcome}
      surface={surface === 'operator' ? 'operator' : 'phone'}
      phase={phase}
      density={handheld ? 'glance' : 'full'}
      recent={recentRows(!params.has('kind') || params.has('more'))}
      clock={FIXTURE_NOW}
      tint={params.has('tint') ? TINT[outcome.kind] : 'none'}
      look={lookFromUrl(params)}
      chips={<CountChip count={312} capacity={500} />}
      menu={<MenuTrigger />}
      onLookup={() => setLooking(true)}
      onPass={(_card, shown) => setInspection({ ...withCard(shown), live: true })}
    >
      <VisualLookup open={looking} onClose={() => setLooking(false)} />
      {inspection ? (
        <PassInspector
          inspection={inspection}
          api={api}
          where="Front door"
          onClose={() => setInspection(null)}
        />
      ) : null}
    </ScanPreviewScreen>
  );
}

/** The desk card of a pass with no photo: Add photo, as a Desk device shows it. */
function PhotoVisual() {
  const [api] = useState(() => ({ addPhoto: async () => ({}) }) as unknown as ScanApi);
  const [outcome] = useState(() => fixtureOutcome('ready', 'choose'));
  return <ScanPreviewScreen outcome={outcome} surface="operator" addPhoto={api} />;
}

export function ScanVisualGallery() {
  const params = new URLSearchParams(location.search);
  const surface = params.get('surface') ?? 'scanner';
  const selected =
    SCAN_VISUAL_CASES.find((item) => item.id === params.get('pass')) ?? SCAN_VISUAL_CASES[0];
  if (!selected) return null;
  const status = params.get('status') ?? 'accepted';
  const phase = params.get('phase') === 'rising' ? 'rising' : 'up';
  if (surface === 'operator' && params.has('case'))
    return (
      <OperatorVisual scenario={OPERATOR_CASES.find((c) => c === params.get('case')) ?? 'idle'} />
    );
  if (surface === 'photo') return <PhotoVisual />;
  if (surface === 'hardware') return <HardwareVisual />;
  if (surface === 'pin-reset') return <PinResetVisual />;
  if (surface === 'staff') return <StaffVisual by={params.get('by') ?? 'pin'} />;
  if (surface === 'closed') return <ClosedVisual who={params.get('who') ?? 'manager'} />;
  if (surface === 'monitor' && params.has('desk'))
    return (
      <MonitorDeskVisual mode={MONITOR_DESK_CASES.find((c) => c === params.get('desk')) ?? 'off'} />
    );
  if (surface === 'monitor')
    return (
      <MonitorVisual
        count={Number(params.get('count') ?? 42)}
        capacity={params.get('capacity') === 'none' ? null : Number(params.get('capacity') ?? 120)}
      />
    );
  if (surface === 'duo') return <DuoVisual status={status} />;
  if (surface === 'tray')
    return <TrayVisual tray={TRAY_CASES.find((c) => c === params.get('case')) ?? 'enter'} />;
  if (surface === 'access')
    return (
      <AccessVisual scenario={ACCESS_SCENARIOS.find((c) => c === params.get('case')) ?? 'grant'} />
    );
  if (surface === 'door')
    return <DoorVisual scenario={DOOR_CASES.find((c) => c === params.get('case')) ?? 'ready'} />;
  if (surface === 'offline')
    return (
      <OfflineVisual
        scenario={OFFLINE_SCENARIOS.find((c) => c === params.get('case')) ?? 'queued'}
      />
    );
  if (surface === 'tags')
    return (
      <TagVisual
        scenario={TAG_SCENARIOS.find((c) => c === params.get('case')) ?? 'assign-tag-android'}
      />
    );
  if (surface === 'replaced')
    return (
      <ScanPreviewScreen
        outcome={fixtureOutcome('refused', 'code_replaced', {
          display: {
            ...selected.outcome.display,
            identity: { holder: '', initials: '', photo: null },
          } as never,
          card: null,
        })}
        surface="operator"
        phase={phase}
        onPass={() => {}}
      />
    );
  const session = sessionFor(surface);
  if (surface === 'customer') return <LiveVisual session={session} status={status} />;
  return <ScanResultVisual surface={surface} selected={selected} phase={phase} />;
}
