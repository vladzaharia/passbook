import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScanCustomerView } from '../../../shared/contracts/scan-customer.ts';
import type { ScanLiveRow } from '../../../shared/contracts/scan-setups.ts';
import { sessionFixture } from '../boot/session.test-support.ts';
import { LiveScreen } from './live-screen.tsx';

const READY = '01900000-0000-7000-8000-000000000001';
const OTHER = '01900000-0000-7000-8000-000000000002';

class LiveSocket {
  static readonly OPEN = 1;
  static instances: LiveSocket[] = [];
  readyState = LiveSocket.OPEN;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor(_url: string) {
    LiveSocket.instances.push(this);
  }
  send() {}
  close() {
    this.readyState = 3;
  }
  say(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const view = (
  screen: 'ready' | 'review',
  headline: string,
  sub: string | null,
  figure?: string,
): ScanCustomerView => ({
  v: 1,
  screen,
  ref: READY,
  at: Date.now(),
  where: 'Desk',
  band: { headline, sub },
  greet: 'Hi, Sam',
  chips: [],
  panel: null,
  lines: [],
  milestone: null,
  test: false,
  ...(figure ? { figure } : {}),
});

const ready = (id = READY): ScanLiveRow => ({
  id,
  at: Date.now(),
  scannerId: READY,
  scannerName: 'Desk',
  passId: null,
  holder: null,
  photoUrl: null,
  kind: 'ready',
  direction: null,
  label: 'Hi, Sam',
  presented: true,
  customer: view('ready', 'Hi, Sam', null),
});

const draft = (ref: string, at: number, figure = '$12.00') => ({
  draft: { ref, at, customer: view('review', 'To pay', 'Balance after: $30.50', figure) },
});

function screen() {
  const base = sessionFixture();
  const session = {
    ...base,
    scanner: base.scanner ? { ...base.scanner, deviceRole: 'customer' as const } : null,
  };
  const out = render(<LiveScreen session={session} refetch={vi.fn(async () => {})} />);
  const socket = LiveSocket.instances[0] as LiveSocket;
  return {
    ...out,
    socket,
    hero: out.container.querySelector('[data-testid="duo-customer-display"]'),
  };
}

beforeEach(() => {
  LiveSocket.instances = [];
  vi.stubGlobal('WebSocket', LiveSocket);
  vi.stubGlobal(
    'matchMedia',
    (query: string) => ({ matches: false, media: query }) as MediaQueryList,
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('customer screen draft', () => {
  it('shows the amount and the balance over the ready card, with the inspect buddy', () => {
    const { socket, hero, getByTestId } = screen();
    act(() => socket.say({ cursor: READY, rows: [ready()] }));
    act(() => socket.say(draft(READY, Date.now())));
    expect(getByTestId('customer-draft')).toHaveTextContent('To pay $12.00');
    expect(hero).toHaveTextContent('Balance after: $30.50');
    expect(hero).toHaveTextContent('Hi, Sam');
    expect(hero?.querySelector('[data-buddy]')).toHaveAttribute('data-scene', 'inspect');
    act(() => socket.say(draft(READY, Date.now() + 5, '$15.00')));
    expect(getByTestId('customer-draft')).toHaveTextContent('$15.00');
  });

  it('ignores a draft for another ref, an old one and an out-of-order one', () => {
    const { socket, queryByTestId } = screen();
    act(() => socket.say({ cursor: READY, rows: [ready()] }));
    act(() => socket.say(draft(OTHER, Date.now())));
    act(() => socket.say(draft(READY, Date.now() - 61_000)));
    expect(queryByTestId('customer-draft')).toBeNull();
  });

  it('a committed row replaces the draft and a cancel drops the draft and the ready card', () => {
    const { socket, queryByTestId, hero } = screen();
    act(() => socket.say({ cursor: READY, rows: [ready()] }));
    act(() => socket.say(draft(READY, Date.now())));
    act(() =>
      socket.say({ cursor: OTHER, rows: [{ ...ready(OTHER), kind: 'ok', label: 'Paid $12.00' }] }),
    );
    expect(queryByTestId('customer-draft')).toBeNull();
    expect(hero).toHaveAttribute('data-status', 'accepted');
  });

  it('a cancel clears both', () => {
    const { socket, queryByTestId, hero } = screen();
    act(() => socket.say({ cursor: READY, rows: [ready()] }));
    act(() => socket.say(draft(READY, Date.now())));
    act(() => socket.say({ draft: { ref: READY, at: Date.now() + 1, cancelled: true } }));
    expect(queryByTestId('customer-draft')).toBeNull();
    expect(hero).toHaveAttribute('data-status', 'ready');
    expect(hero).not.toHaveTextContent('Hi, Sam');
    act(() => socket.say({ cursor: READY, rows: [ready()] }));
    expect(hero).not.toHaveTextContent('Hi, Sam');
  });
});
