import { useEffect, useState } from 'react';
import type { ScanSession } from '../../shared/contracts/scan-session.ts';
import type { ScanLiveRow } from '../../shared/contracts/scan-setups.ts';
import { Buddy } from '../ui/art/buddy.tsx';
import type { ScanApi } from './api/scan-api.ts';
import { ScanAppView } from './app.tsx';
import { sessionFixture } from './boot/session.test-support.ts';
import { CustomerDisplayPage } from './customer-display.tsx';
import { LiveScreen } from './live/live-screen.tsx';
import { initialState } from './machine/initial-state.ts';
import { viewOf } from './machine/present.ts';
import type { ScanStore } from './machine/store.ts';
import { ScanStoreContext } from './machine/use-scan-machine.ts';
import { OperatorPanel } from './operator/operator-panel.tsx';
import type { ScanRuntime } from './platform/runtime.ts';
import { scanBrandLogoUrl } from './platform/scan-branding.tsx';
import { type PassInspection, PassInspector } from './result/pass-inspector.tsx';
import { ResultCard } from './result/result-card.tsx';
import { DoorDock } from './ui/door-dock.tsx';
import { SCAN_VISUAL_CASES } from './visual-cases.test-support.ts';
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
}

function sessionFor(surface: string): ScanSession {
  const base = sessionFixture({ branding: BRANDING });
  const scanner = base.scanner ? { ...base.scanner, orgName: 'Northwind Live' } : null;
  return {
    ...base,
    scanner: scanner && surface === 'customer' ? { ...scanner, deviceRole: 'customer' } : scanner,
  };
}

function useVisualStore() {
  const [store] = useState(() => {
    const state = initialState(Date.now());
    const snapshot = { state, view: viewOf(state), now: Date.now() };
    return {
      getSnapshot: () => snapshot,
      subscribe: () => () => undefined,
      dispatch: () => undefined,
      checkIn: () => undefined,
      configure: () => true,
      retryUnsure: () => undefined,
      dispose: () => undefined,
    } as ScanStore;
  });
  return store;
}

function OperatorVisual({ session, name }: { session: ScanSession; name: string }) {
  const store = useVisualStore();
  const [runtime] = useState(
    () => ({ store, emit: () => null, checkIn: () => undefined }) as unknown as ScanRuntime,
  );
  const [api] = useState(
    () =>
      ({
        activity: async () => ({
          items: [
            {
              id: ID,
              at: Date.now(),
              deviceId: ID,
              deviceName: 'West entrance',
              passId: ID,
              title: `${name} · accepted`,
              outcome: 'ok',
              direction: 'in',
            },
          ],
        }),
        lookup: async () => ({ items: [], more: false }),
      }) as unknown as ScanApi,
  );
  return (
    <ScanStoreContext.Provider value={store}>
      <OperatorPanel api={api} runtime={runtime} session={session} />
    </ScanStoreContext.Provider>
  );
}

function LiveVisual({ session, status }: { session: ScanSession; status: string }) {
  const [installed] = useState(() => {
    VisualSocket.instances = [];
    window.WebSocket = VisualSocket as unknown as typeof WebSocket;
    return true;
  });
  useEffect(() => {
    if (!installed) return;
    const id = `${ID.slice(0, -1)}2`;
    const row: ScanLiveRow = {
      id,
      at: Date.now(),
      scannerId: ID,
      scannerName: 'West entrance',
      passId: ID,
      holder: 'Private pass holder',
      photoUrl: null,
      kind: status === 'refused' ? 'refused' : 'ok',
      direction: 'in',
      label: status === 'refused' ? 'Not accepted' : 'Checked in',
      presented: true,
    };
    const timer = window.setTimeout(() => VisualSocket.instances.at(-1)?.publish(row), 40);
    return () => window.clearTimeout(timer);
  }, [installed, status]);
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
  session,
  phase,
}: {
  surface: string;
  selected: (typeof SCAN_VISUAL_CASES)[number];
  session: ScanSession;
  phase: 'up' | 'rising';
}) {
  const [inspection, setInspection] = useState<PassInspection | null>(null);
  const store = useVisualStore();
  const [api] = useState(() => ({ resolve: async () => selected.outcome }) as unknown as ScanApi);
  const [runtime] = useState(
    () =>
      ({
        store,
        camera: { hasTorch: () => false, toggleTorch: async () => false },
      }) as unknown as ScanRuntime,
  );
  const logoUrl = scanBrandLogoUrl(BRANDING, session);
  return (
    <ScanStoreContext.Provider value={store}>
      <ScanAppView
        screen={{ s: 'loop' }}
        surface={surface === 'operator' ? 'operator' : 'phone'}
        branding={BRANDING}
        capsule={{
          name: 'West entrance',
          orgName: 'Northwind Live',
          logoUrl,
          state: 'scanning',
        }}
        camera={<div className="scan-visual-camera" />}
        sidebar={
          surface === 'operator' ? <OperatorVisual session={session} name={selected.name} /> : null
        }
        buddy={<Buddy scene="scan" size="xl-scan" mood="happy" immediate />}
        strip={{ kind: 'ok', title: 'Taylor Chen', meta: '6:42 PM', undoable: true }}
        dockRow={
          <DoorDock
            outcome={selected.outcome}
            runtime={runtime}
            open={() => undefined}
            onError={() => undefined}
          />
        }
        card={
          <ResultCard
            outcome={selected.outcome}
            phase={phase}
            onPass={(card) => {
              if (card) setInspection({ card });
            }}
          />
        }
      />
      {inspection ? (
        <PassInspector inspection={inspection} api={api} onClose={() => setInspection(null)} />
      ) : null}
    </ScanStoreContext.Provider>
  );
}

export function ScanVisualGallery() {
  const params = new URLSearchParams(location.search);
  const surface = params.get('surface') ?? 'scanner';
  const selected =
    SCAN_VISUAL_CASES.find((item) => item.id === params.get('pass')) ?? SCAN_VISUAL_CASES[0];
  if (!selected) return null;
  const status = params.get('status') ?? 'accepted';
  const phase = params.get('phase') === 'rising' ? 'rising' : 'up';
  if (surface === 'duo') return <DuoVisual status={status} />;
  const session = sessionFor(surface);
  if (surface === 'customer') return <LiveVisual session={session} status={status} />;
  return <ScanResultVisual surface={surface} selected={selected} session={session} phase={phase} />;
}
