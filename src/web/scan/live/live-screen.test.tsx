import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScanLiveRow } from '../../../shared/contracts/scan-setups.ts';
import { sessionFixture } from '../boot/session.test-support.ts';
import { LiveScreen } from './live-screen.tsx';

const ID = '01900000-0000-7000-8000-000000000001';

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
    this.onclose?.({ code: 1000 });
  }
  snapshot(welcome?: string) {
    this.onmessage?.({ data: JSON.stringify({ cursor: null, rows: [], welcome }) });
  }
  publish(row: ScanLiveRow) {
    this.onmessage?.({ data: JSON.stringify({ cursor: row.id, rows: [row] }) });
  }
}

function row(kind: ScanLiveRow['kind'], id: string): ScanLiveRow {
  return {
    id,
    at: Date.now(),
    scannerId: ID,
    scannerName: 'Front door',
    passId: null,
    holder: null,
    photoUrl: null,
    kind,
    direction: kind === 'ok' ? 'in' : null,
    label: kind === 'ok' ? 'Checked in' : kind === 'refused' ? 'Not accepted' : 'Check required',
    presented: true,
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('customer live screen Buddy', () => {
  it('uses a large idle scene and replays status-specific motion for each scan result', () => {
    const base = sessionFixture();
    const session = {
      ...base,
      scanner: base.scanner ? { ...base.scanner, deviceRole: 'customer' as const } : null,
    };
    const { container } = render(<LiveScreen session={session} refetch={vi.fn(async () => {})} />);
    const hero = container.querySelector('[data-testid="duo-customer-display"]');
    const art = hero?.querySelector('[data-buddy]');
    const socket = LiveSocket.instances[0];

    expect(hero).toHaveAttribute('data-status', 'ready');
    expect(art).toHaveAttribute('data-scene', 'wave');
    expect(art?.querySelector('.wl-art')).toHaveAttribute('data-size', 'xl-scan');
    expect(socket).toBeDefined();

    act(() => socket?.publish(row('ok', `${ID.slice(0, -1)}2`)));
    expect(hero).toHaveAttribute('data-status', 'accepted');
    expect(art).toHaveAttribute('data-scene', 'cheer');
    expect(art).toHaveAttribute('data-run');
    const checkout = {
      ...row('ok', `${ID.slice(0, -1)}4`),
      direction: 'out' as const,
      label: 'Checked out',
    };
    act(() => socket?.publish(checkout));
    expect(art).toHaveAttribute('data-scene', 'wave');
    expect(hero?.querySelector('h1')).toHaveTextContent('Checked out');

    act(() => socket?.publish(row('refused', `${ID.slice(0, -1)}5`)));
    expect(hero).toHaveAttribute('data-status', 'rejected');
    expect(art).toHaveAttribute('data-scene', 'sorry');
    expect(art).toHaveAttribute('data-run');
  });
  it('returns the customer screen to the welcome wave after the result hold', () => {
    vi.useFakeTimers();
    const base = sessionFixture();
    const session = {
      ...base,
      scanner: base.scanner ? { ...base.scanner, deviceRole: 'customer' as const } : null,
    };
    const { container } = render(<LiveScreen session={session} refetch={vi.fn(async () => {})} />);
    const socket = LiveSocket.instances[0];
    const hero = container.querySelector('[data-testid="duo-customer-display"]');
    const buddy = hero?.querySelector('[data-buddy]');

    act(() => socket?.publish(row('ok', `${ID.slice(0, -1)}4`)));
    expect(hero).toHaveAttribute('data-status', 'accepted');
    expect(buddy).toHaveAttribute('data-scene', 'cheer');

    act(() => vi.advanceTimersByTime(4_001));
    expect(hero).toHaveAttribute('data-status', 'ready');
    expect(buddy).toHaveAttribute('data-scene', 'wave');
  });

  it('uses the org accent and logo in the customer header without exposing pass identity', () => {
    const base = sessionFixture({
      branding: {
        accent: '#0f766e',
        logo: { sha: 'a'.repeat(64), w: 480, h: 150 },
      },
    });
    const session = {
      ...base,
      scanner: base.scanner ? { ...base.scanner, deviceRole: 'customer' as const } : null,
    };
    const { container } = render(<LiveScreen session={session} refetch={vi.fn(async () => {})} />);
    const page = container.querySelector<HTMLElement>('[data-testid="duo-customer-display"]');
    const logo = container.querySelector<HTMLImageElement>('.cstage-brand-logo');

    expect(page?.style.getPropertyValue('--scan-org-accent')).toBe('#0f766e');
    expect(logo?.src).toContain(`/api/v1/scan/branding/logo?v=${'a'.repeat(64)}`);
    expect(logo?.alt).toBe('Organization logo');
    expect(container.textContent).not.toContain('Private pass holder');

    if (!logo) throw new Error('Expected the configured organization logo.');
    fireEvent.error(logo);
    expect(container.querySelector('.cstage-brand-mark span')).toBeInTheDocument();
  });

  it('shows the session welcome when idle, the fixed copy otherwise', () => {
    vi.useFakeTimers();
    const base = sessionFixture();
    const session = {
      ...base,
      scanner: base.scanner ? { ...base.scanner, deviceRole: 'customer' as const } : null,
    };
    const { container } = render(<LiveScreen session={session} refetch={vi.fn(async () => {})} />);
    expect(container.querySelector('h1')).toHaveTextContent('Hold up your pass');
    act(() => LiveSocket.instances.at(-1)?.snapshot('Scan to enter'));
    expect(container.querySelector('h1')).toHaveTextContent('Scan to enter');
    act(() => LiveSocket.instances.at(-1)?.close());
    act(() => vi.advanceTimersByTime(2000));
    act(() => LiveSocket.instances.at(-1)?.snapshot());
    expect(container.querySelector('h1')).toHaveTextContent('Hold up your pass');
    vi.useRealTimers();
  });

  it('shows the server view, not the scanner name or "Customer display"', () => {
    const base = sessionFixture();
    const session = {
      ...base,
      scanner: base.scanner ? { ...base.scanner, deviceRole: 'customer' as const } : null,
    };
    const { container } = render(<LiveScreen session={session} refetch={vi.fn(async () => {})} />);
    expect(container.textContent).not.toContain('Customer display');
    expect(container.textContent).not.toContain(base.scanner?.name ?? 'no-name');
    expect(container.querySelector('h1')).toHaveTextContent('Hold up your pass');
    const customer = {
      v: 1 as const,
      screen: 'ok' as const,
      ref: 'r1',
      at: Date.now(),
      where: 'Front',
      band: { headline: 'Checked in', sub: null },
      greet: 'Hi, Sam',
      chips: [],
      panel: null,
      lines: [],
      milestone: null,
      test: false,
    };
    act(() => LiveSocket.instances[0]?.publish({ ...row('ok', `${ID.slice(0, -1)}9`), customer }));
    expect(container.querySelector('h1')).toHaveTextContent('Checked in');
    expect(container).toHaveTextContent('Hi, Sam');
  });
});

describe('monitor setup access', () => {
  it('hides Refresh setup until staff hold the name or press Enter on it', () => {
    vi.useFakeTimers();
    const { getByRole, queryByRole } = render(
      <LiveScreen session={sessionFixture()} refetch={vi.fn(async () => {})} />,
    );
    expect(queryByRole('button', { name: 'Refresh setup' })).toBeNull();
    const brand = getByRole('button', { name: /setup options$/ });
    fireEvent.pointerDown(brand);
    act(() => vi.advanceTimersByTime(950));
    expect(getByRole('button', { name: 'Refresh setup' })).toBeVisible();
    // Focus holds it open for a keyboard user; it hides 12 s after focus leaves.
    fireEvent.blur(getByRole('button', { name: 'Refresh setup' }));
    act(() => vi.advanceTimersByTime(12_100));
    expect(queryByRole('button', { name: 'Refresh setup' })).toBeNull();
    fireEvent.click(brand, { detail: 0 });
    expect(getByRole('button', { name: 'Refresh setup' })).toBeVisible();
  });
});
