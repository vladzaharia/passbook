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
    const hero = container.querySelector('.scan-live-welcome');
    const art = hero?.querySelector('[data-buddy]');
    const socket = LiveSocket.instances[0];

    expect(hero).toHaveAttribute('data-kind', 'ready');
    expect(art).toHaveAttribute('data-scene', 'wave');
    expect(art?.querySelector('.wl-art')).toHaveAttribute('data-size', 'xl-scan');
    expect(socket).toBeDefined();

    act(() => socket?.publish(row('ok', `${ID.slice(0, -1)}2`)));
    expect(hero).toHaveAttribute('data-kind', 'ok');
    expect(art).toHaveAttribute('data-scene', 'cheer');
    expect(art).toHaveAttribute('data-run');
    const checkout = {
      ...row('ok', `${ID.slice(0, -1)}4`),
      direction: 'out' as const,
      label: 'Checked out',
    };
    act(() => socket?.publish(checkout));
    expect(art).toHaveAttribute('data-scene', 'wave');
    expect(hero?.querySelector('h2')).toHaveTextContent('Checked out');

    act(() => socket?.publish(row('refused', `${ID.slice(0, -1)}5`)));
    expect(hero).toHaveAttribute('data-kind', 'refused');
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
    const hero = container.querySelector('.scan-live-welcome');
    const buddy = hero?.querySelector('[data-buddy]');

    act(() => socket?.publish(row('ok', `${ID.slice(0, -1)}4`)));
    expect(hero).toHaveAttribute('data-kind', 'ok');
    expect(buddy).toHaveAttribute('data-scene', 'cheer');

    act(() => vi.advanceTimersByTime(4_001));
    expect(hero).toHaveAttribute('data-kind', 'ready');
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
    const page = container.querySelector<HTMLElement>('[data-testid="scan-live"]');
    const logo = container.querySelector<HTMLImageElement>('.scan-live-logo');

    expect(page?.style.getPropertyValue('--scan-org-accent')).toBe('#0f766e');
    expect(logo?.src).toContain(`/api/v1/scan/branding/logo?v=${'a'.repeat(64)}`);
    expect(logo?.alt).toBe('Henry logo');
    expect(container.textContent).not.toContain('Private pass holder');

    if (!logo) throw new Error('Expected the configured organization logo.');
    fireEvent.error(logo);
    expect(container.querySelector('.scan-live-brand-icon svg')).toBeInTheDocument();
  });
});
