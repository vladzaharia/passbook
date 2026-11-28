import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionFixture } from '../boot/session.test-support.ts';
import { CustomerDisplayPage } from '../customer-display.tsx';
import { LiveScreen } from '../live/live-screen.tsx';
import { LoopMenu } from '../loop-menu.tsx';
import { initialState } from '../machine/initial-state.ts';
import type { ScanRuntime } from '../platform/runtime.ts';

class Socket {
  static readonly OPEN = 1;
  readyState = 1;
  onmessage = null;
  onclose = null;
  send() {}
  close() {}
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => vi.unstubAllGlobals());

const withRole = (deviceRole: 'monitor' | 'customer') => {
  const base = sessionFixture();
  return { ...base, scanner: base.scanner ? { ...base.scanner, deviceRole } : null };
};

describe('where the hardware pill shows', () => {
  it('sits beside the scanner menu on door, handheld, desk and operator views', () => {
    const runtime = {
      webNfc: { status: () => 'idle', arm: vi.fn(), supported: false },
      camera: { hasWide: () => false, start: vi.fn(), choose: vi.fn(), stop: vi.fn() },
      emit: vi.fn(),
      hold: vi.fn(),
    } as unknown as ScanRuntime;
    render(
      <LoopMenu
        s={initialState(Date.now())}
        session={sessionFixture()}
        api={{} as never}
        runtime={runtime}
        tags={{ menu: null } as never}
        dispatch={vi.fn()}
        refetch={async () => undefined}
        leave={vi.fn()}
        operator={false}
        duoLayout={false}
        readerUsable={false}
        cameraChoice="back"
        setCameraChoice={vi.fn()}
        setCameraError={vi.fn()}
        showPanel={vi.fn()}
      />,
    );
    const pill = screen.getByTestId('hardware-pill');
    const menu = screen.getByRole('button', { name: 'Menu' });
    expect(pill.compareDocumentPosition(menu) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows on the monitor', () => {
    render(<LiveScreen session={withRole('monitor')} refetch={async () => undefined} />);
    expect(screen.getByTestId('hardware-pill')).toBeInTheDocument();
  });

  it('never shows to customers', () => {
    const { unmount } = render(
      <LiveScreen session={withRole('customer')} refetch={async () => undefined} />,
    );
    expect(screen.queryByTestId('hardware-pill')).toBeNull();
    unmount();
    render(<CustomerDisplayPage />);
    expect(screen.queryByTestId('hardware-pill')).toBeNull();
  });
});
