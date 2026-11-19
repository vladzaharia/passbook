import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import type { ScanLiveRow } from '../../../shared/contracts/scan-setups.ts';
import { ThemeProvider } from '../../lib/theme.tsx';
import type { ScanApi } from '../api/scan-api.ts';
import { sessionFixture } from '../boot/session.test-support.ts';
import { insideRow } from '../inside/inside-fake.test-support.ts';
import type { InsideList } from '../inside/inside-types.ts';
import { fixtureOutcome } from '../machine/fixture-data.test-support.ts';
import { LiveScreen } from './live-screen.tsx';

const ID = '01900000-0000-7000-8000-000000000001';
const SCAN = '01900000-0000-7000-8000-0000000000aa';

class LiveSocket {
  static readonly OPEN = 1;
  static instances: LiveSocket[] = [];
  readyState = LiveSocket.OPEN;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onopen: (() => void) | null = null;
  constructor(_url: string) {
    LiveSocket.instances.push(this);
  }
  send() {}
  close() {}
  publish(rows: ScanLiveRow[]) {
    this.onmessage?.({ data: JSON.stringify({ cursor: 'c', rows }) });
  }
}

const refused = (over: Partial<ScanLiveRow> = {}): ScanLiveRow => ({
  id: 'r1',
  at: Date.now(),
  scannerId: ID,
  scannerName: 'Front door',
  passId: '01900000-0000-7000-8000-0000000000bb',
  holder: 'Leo Park',
  photoUrl: null,
  kind: 'refused',
  direction: null,
  label: 'Not accepted',
  presented: true,
  ...over,
});

function monitor(settings: { deskActions?: boolean }, staff: boolean): ScanSession {
  const base = sessionFixture();
  return {
    ...base,
    staff: staff ? { id: ID, name: 'Ana Ruiz', role: 'desk' } : null,
    staffList: staff ? null : [{ id: ID, name: 'Ana Ruiz', role: 'desk' }],
    scanner: base.scanner
      ? {
          ...base.scanner,
          deviceRole: 'monitor',
          settings: { ...base.scanner.settings, staffSignIn: true, ...settings },
        }
      : null,
  };
}

function fakeApi() {
  const list: InsideList = {
    places: [{ place: 'zone:gym', name: 'Gym', inNow: 2, capacity: null, rev: 1 }],
    items: [
      insideRow(1, { photoUrl: '/api/v1/scan/photo/x' }),
      insideRow(2, { photoUrl: null, plan: 'Visitor' }),
    ],
    total: 2,
    nextCursor: null,
    asOf: Date.now(),
  };
  return {
    inside: vi.fn(async () => list),
    override: vi.fn(async () => fixtureOutcome('ok', null, { scanId: SCAN })),
    undo: vi.fn(async () => fixtureOutcome('ok')),
    markOut: vi.fn(),
    undoMarkOut: vi.fn(),
    staffSignOut: vi.fn(async () => sessionFixture()),
  };
}

beforeEach(() => {
  LiveSocket.instances = [];
  vi.stubGlobal('WebSocket', LiveSocket);
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('monitor Desk actions', () => {
  it('stays read-only when the setting is off: no list, no sign-in, no Let in', () => {
    const api = fakeApi();
    render(
      <LiveScreen
        session={monitor({}, true)}
        refetch={async () => {}}
        api={api as unknown as ScanApi}
      />,
    );
    act(() => LiveSocket.instances[0]?.publish([refused({ scanId: SCAN })]));
    expect(api.inside).not.toHaveBeenCalled();
    expect(screen.queryByText('Sign in to act')).toBeNull();
    expect(screen.queryByRole('button', { name: /let in/i })).toBeNull();
  });

  it('asks for a staff sign-in when the setting is on and nobody is signed in', () => {
    const api = fakeApi();
    render(
      <LiveScreen
        session={monitor({ deskActions: true }, false)}
        refetch={async () => {}}
        api={api as unknown as ScanApi}
      />,
    );
    act(() => LiveSocket.instances[0]?.publish([refused()]));
    expect(screen.getByText('Sign in to act')).toBeInTheDocument();
    expect(api.inside).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /let in/i })).toBeNull();
  });

  it('lists who is inside from the server payload, photos only when sent', async () => {
    const api = fakeApi();
    const { container } = render(
      <ThemeProvider>
        <LiveScreen
          session={monitor({ deskActions: true }, true)}
          refetch={async () => {}}
          api={api as unknown as ScanApi}
        />
      </ThemeProvider>,
    );
    act(() => LiveSocket.instances[0]?.onopen?.());
    await waitFor(() => expect(screen.getAllByTestId('inside-row')).toHaveLength(2));
    expect(container.querySelectorAll('.scan-in-photo')).toHaveLength(1);
    expect(screen.getByText('Visitor')).toBeInTheDocument();
    expect(screen.getByTestId('monitor-staff')).toHaveTextContent('Ana Ruiz');
  });

  it('lets in a refusal the server marked, once, through the override route', async () => {
    const api = fakeApi();
    render(
      <ThemeProvider>
        <LiveScreen
          session={monitor({ deskActions: true }, true)}
          refetch={async () => {}}
          api={api as unknown as ScanApi}
        />
      </ThemeProvider>,
    );
    act(() =>
      LiveSocket.instances[0]?.publish([
        refused({ id: 'r1', scanId: SCAN }),
        refused({ id: 'r2', holder: 'Sam Kim' }),
      ]),
    );
    const buttons = screen.getAllByRole('button', { name: /^let in:/i });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0] as HTMLElement);
    await waitFor(() => expect(api.override).toHaveBeenCalledTimes(1));
    expect(api.override).toHaveBeenCalledWith(expect.objectContaining({ overrideOf: SCAN }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^let in:/i })).toBeNull());
    expect(screen.getByText('Resolved by Ana Ruiz')).toBeInTheDocument();
  });
});
