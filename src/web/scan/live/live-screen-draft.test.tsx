import { act, render, waitFor } from '@testing-library/react';
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
    expect(getByTestId('customer-draft')).toHaveAttribute('aria-label', 'To pay $12.00');
    expect(hero).toHaveTextContent('Balance after: $30.50');
    expect(hero).toHaveTextContent('Hi, Sam');
    expect(hero?.querySelector('[data-buddy]')).toHaveAttribute('data-scene', 'inspect');
    act(() => socket.say(draft(READY, Date.now() + 5, '$15.00')));
    expect(getByTestId('customer-draft')).toHaveTextContent('$15.00');
  });

  it('shows a draft over an idle screen, as when the session hides the desk card', () => {
    const { socket, hero, getByTestId } = screen();
    act(() => socket.say(draft(READY, Date.now())));
    expect(getByTestId('customer-draft')).toHaveTextContent('To pay $12.00');
    expect(hero).toHaveAttribute('data-status', 'review');
  });

  it('ignores a draft past its hold and one older than the card on screen', () => {
    const { socket, queryByTestId } = screen();
    act(() => socket.say({ cursor: READY, rows: [ready()] }));
    act(() => socket.say(draft(OTHER, Date.now() - 1_000)));
    act(() => socket.say(draft(READY, Date.now() - 21_000)));
    expect(queryByTestId('customer-draft')).toBeNull();
  });

  it('a late draft after the receipt does not show, and a receipt replaces the draft', async () => {
    const { socket, queryByTestId, hero } = screen();
    act(() => socket.say({ cursor: READY, rows: [ready()] }));
    act(() => socket.say(draft(READY, Date.now())));
    const receipt = {
      ...ready(OTHER),
      kind: 'ok' as const,
      label: 'Paid $12.00',
      at: Date.now() + 5_000,
    };
    act(() => socket.say({ cursor: OTHER, rows: [receipt] }));
    await waitFor(() => expect(queryByTestId('customer-draft')).toBeNull());
    expect(hero).toHaveAttribute('data-status', 'accepted');
    // A draft that was on the wire when the receipt landed is older than it.
    act(() => socket.say(draft(READY, Date.now() + 1_000)));
    expect(queryByTestId('customer-draft')).toBeNull();
  });

  it('a draft-only cancel keeps the ready card, and a re-pick shows again', async () => {
    const { socket, queryByTestId, hero, getByTestId } = screen();
    act(() => socket.say({ cursor: READY, rows: [ready()] }));
    act(() => socket.say(draft(READY, Date.now())));
    act(() =>
      socket.say({ draft: { ref: READY, at: Date.now() + 1, cancelled: true, keep: 'ready' } }),
    );
    await waitFor(() => expect(queryByTestId('customer-draft')).toBeNull());
    expect(hero).toHaveTextContent('Hi, Sam');
    act(() => socket.say(draft(READY, Date.now() + 2, '$7.00')));
    expect(getByTestId('customer-draft')).toHaveTextContent('To pay $7.00');
  });

  it('a full cancel clears both, and the ready card does not come back', async () => {
    const { socket, queryByTestId, hero } = screen();
    act(() => socket.say({ cursor: READY, rows: [ready()] }));
    act(() => socket.say(draft(READY, Date.now())));
    act(() => socket.say({ draft: { ref: READY, at: Date.now() + 1, cancelled: true } }));
    await waitFor(() => expect(queryByTestId('customer-draft')).toBeNull());
    expect(hero).toHaveAttribute('data-status', 'ready');
    expect(hero).not.toHaveTextContent('Hi, Sam');
    act(() => socket.say({ cursor: READY, rows: [ready()] }));
    expect(hero).not.toHaveTextContent('Hi, Sam');
  });

  it('two desks on one screen keep their own drafts', () => {
    const { socket, getByTestId } = screen();
    act(() => socket.say(draft(READY, Date.now(), '$12.00')));
    act(() => socket.say(draft(OTHER, Date.now() + 5, '$3.00')));
    expect(getByTestId('customer-draft')).toHaveTextContent('$3.00');
    act(() =>
      socket.say({ draft: { ref: OTHER, at: Date.now() + 6, cancelled: true, keep: 'ready' } }),
    );
    return waitFor(() => expect(getByTestId('customer-draft')).toHaveTextContent('$12.00'));
  });
});
