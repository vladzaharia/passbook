import { useEffect, useState } from 'react';
import type { ScanSession } from '../../shared/contracts/scan-session.ts';
import type { ScanLiveRow } from '../../shared/contracts/scan-setups.ts';
import type { ScanApi } from './api/scan-api.ts';
import { sessionFixture } from './boot/session.test-support.ts';
import { CustomerDisplayPage } from './customer-display.tsx';
import { LiveScreen } from './live/live-screen.tsx';
import { ScanPreviewScreen } from './preview-screen.tsx';
import { type PassInspection, PassInspector } from './result/pass-inspector.tsx';
import { ACCESS_SCENARIOS, AccessVisual } from './visual-access.tsx';
import { SCAN_VISUAL_CASES } from './visual-cases.test-support.ts';
import { TAG_SCENARIOS, TagVisual } from './visual-tags.tsx';
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
  phase,
}: {
  surface: string;
  selected: (typeof SCAN_VISUAL_CASES)[number];
  phase: 'up' | 'rising';
}) {
  const [inspection, setInspection] = useState<PassInspection | null>(null);
  const [api] = useState(() => ({ resolve: async () => selected.outcome }) as unknown as ScanApi);
  return (
    <>
      <ScanPreviewScreen
        outcome={selected.outcome}
        surface={surface === 'operator' ? 'operator' : 'phone'}
        phase={phase}
        onPass={(card) => {
          if (card) setInspection({ card });
        }}
      />
      {inspection ? (
        <PassInspector inspection={inspection} api={api} onClose={() => setInspection(null)} />
      ) : null}
    </>
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
  if (surface === 'access')
    return (
      <AccessVisual scenario={ACCESS_SCENARIOS.find((c) => c === params.get('case')) ?? 'grant'} />
    );
  if (surface === 'tags')
    return (
      <TagVisual
        scenario={TAG_SCENARIOS.find((c) => c === params.get('case')) ?? 'assign-tag-android'}
      />
    );
  const session = sessionFor(surface);
  if (surface === 'customer') return <LiveVisual session={session} status={status} />;
  return <ScanResultVisual surface={surface} selected={selected} phase={phase} />;
}
