import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { type BootScreen, ScanAppView, type ScanAppViewProps } from './app.tsx';
import type { BlockKind } from './boot/block-panel.tsx';
import { CountChip, ReaderChip, SyncChip, TestChip } from './ui/chips.tsx';
import { DoorThumbRow } from './ui/dock.tsx';
import { ANNOUNCE_DELAY_MS, LiveAnnouncer } from './ui/live-announcer.tsx';

const noop = () => undefined;
const BLOCKS: BlockKind[] = ['removed', 'expired', 'suspended', 'unassigned', 'signed_out'];
const start = (over: Partial<Extract<BootScreen, { s: 'start' }>> = {}): BootScreen => ({
  s: 'start',
  scannerName: 'Front door',
  orgName: 'Northwind Live',
  state: 'ready',
  event: {
    name: 'Saturday gala',
    when: 'Nov 14 · 6:00 PM – 11:00 PM',
    count: '312 of 500 in',
    note: 'Wristbands at the side door.',
  },
  reentry: true,
  direction: 'in',
  ...over,
});
const SCREENS: [string, BootScreen][] = [
  ['pair', { s: 'pair' }],
  ['pair error', { s: 'pair', error: 'Code not valid. Ask for a new one.' }],
  ['confirm', { s: 'confirm', scannerName: 'Front door', orgName: 'Northwind Live', mode: 'test' }],
  ['start', start()],
  ['start not open', start({ state: 'not_open', time: '4:00 PM' })],
  ['start closed', start({ state: 'closed', time: '11:00 PM' })],
  ['start templates', start({ event: null, templates: ['Coffee card', 'Gym pass'] })],
  ...BLOCKS.map((k): [string, BootScreen] => [`block ${k}`, { s: 'block', kind: k }]),
  ['loop', { s: 'loop' }],
];

const view = (screenState: BootScreen, over: Partial<ScanAppViewProps> = {}) => (
  <ScanAppView
    screen={screenState}
    capsule={{
      name: 'Front door',
      staff: 'Sam K.',
      state: 'scanning',
      chips: (
        <>
          <TestChip mode="test" />
          <ReaderChip state="idle" />
          <SyncChip state={{ kind: 'offline', queued: 3 }} />
          <CountChip count={312} capacity={500} />
        </>
      ),
    }}
    strip={{ kind: 'ok', title: 'Leo Park', meta: '6:42 PM', undoable: true }}
    dockRow={<DoorThumbRow onLookUp={noop} />}
    {...over}
  />
);

describe('every boot state', () => {
  for (const [name, s] of SCREENS) {
    it(`${name}: no axe violations`, async () => {
      const { container } = render(view(s));
      expect((await axe(container)).violations).toEqual([]);
    });
  }

  for (const width of [390, 820, 1180]) {
    for (const theme of ['light', 'dark']) {
      it(`start and the loop at ${width} px, ${theme}: no axe violations`, async () => {
        document.documentElement.dataset.theme = theme;
        for (const s of [start(), { s: 'loop' } as BootScreen]) {
          const { container, unmount } = render(<div style={{ width }}>{view(s)}</div>);
          expect((await axe(container)).violations).toEqual([]);
          unmount();
        }
        delete document.documentElement.dataset.theme;
      });
    }
  }
  it('keeps the camera and desk in separate Duo panes around the reported hinge', () => {
    const duo = {
      surface: 'duo' as const,
      layout: {
        posture: 'half-folded' as const,
        division: { x: 420, y: 0, width: 24, height: 800 },
      },
      camera: <div data-testid="duo-camera" />,
      sidebar: <aside data-testid="duo-desk" />,
    };
    const { container, rerender } = render(view({ s: 'loop' }, duo));
    const shell = container.querySelector<HTMLElement>('.scan-shell');
    expect(screen.getByTestId('duo-camera')).toBeInTheDocument();
    expect(screen.getByTestId('duo-desk')).toBeInTheDocument();
    expect(shell?.style.getPropertyValue('--duo-scan-width')).toBe('420px');
    expect(shell?.style.getPropertyValue('--duo-desk-left')).toBe('444px');
    rerender(view({ s: 'loop' }, { ...duo, layout: { posture: 'unfolded', division: null } }));
    expect(shell?.style.getPropertyValue('--duo-scan-width')).toBe(`${window.innerWidth / 2}px`);
  });

  it('slate blocks are alerts and focus their one action', () => {
    for (const kind of BLOCKS) {
      const { unmount } = render(view({ s: 'block', kind }));
      const alert = screen.getAllByRole('alert')[0];
      expect(alert?.textContent?.length).toBeGreaterThan(10);
      expect(document.activeElement?.tagName).toBe('BUTTON');
      unmount();
    }
  });

  it('pairing uses ten Crockford slots grouped five and five, and Pair waits for all ten', () => {
    const { container } = render(view({ s: 'pair' }));
    expect(container.querySelectorAll('.wl-code-slot')).toHaveLength(10);
    expect(container.querySelector('[data-group-start]')).toBe(
      container.querySelectorAll('.wl-code-slot')[5],
    );
    expect(screen.getByRole('button', { name: 'Pair' })).toBeDisabled();
  });

  it('has the C14 test ids it owns', () => {
    const { container } = render(view({ s: 'loop' }));
    for (const id of ['scan-count', 'scan-last', 'scan-dock']) {
      expect(container.querySelector(`[data-testid="${id}"]`), id).not.toBeNull();
    }
    const s = render(view(start()));
    expect(s.container.querySelector('[data-testid="scan-start"]')).not.toBeNull();
    const p = render(view({ s: 'pair' }));
    expect(p.container.querySelector('[data-testid="pair-code"]')).not.toBeNull();
  });

  it('shows the Test chip in the capsule, outside the tint, and not on live scanners', () => {
    const { container, rerender } = render(view({ s: 'loop' }, { tint: 'green' }));
    const capsule = container.querySelector('[data-testid="scan-capsule"]');
    const tint = container.querySelector('.scan-tint');
    expect(capsule?.textContent).toContain('Test');
    expect(tint?.contains(capsule as Node)).toBe(false);
    expect(tint).toHaveAttribute('data-tint', 'green');
    rerender(
      <ScanAppView
        screen={{ s: 'loop' }}
        capsule={{ name: 'Front door', state: 'scanning', chips: <TestChip mode="live" /> }}
      />,
    );
    expect(screen.queryByText('Test')).toBeNull();
  });

  it('the count chip reads in the phone and wide forms', () => {
    const phone = render(<CountChip count={312} capacity={500} />);
    expect(phone.container.textContent).toBe('312/500');
    const wide = render(<CountChip count={312} capacity={500} wide />);
    expect(wide.container.textContent).toBe('312 of 500 in');
    const reentry = render(<CountChip count={290} out={22} />);
    expect(reentry.container.textContent).toBe('290 in · 22 out');
    const today = render(<CountChip count={42} today />);
    expect(today.container.textContent).toBe('Today 42');
  });

  it('keeps one shell: a single main landmark with two persistent live regions', () => {
    const { container } = render(view({ s: 'loop' }));
    expect(container.querySelectorAll('main')).toHaveLength(1);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
  });
});

describe('LiveAnnouncer', () => {
  it('clears both regions, then sets the right one 50 ms later', () => {
    vi.useFakeTimers();
    const { rerender } = render(<LiveAnnouncer message={null} />);
    const status = screen.getByRole('status');
    const alert = screen.getByRole('alert');
    rerender(<LiveAnnouncer message={{ text: 'Checked in. Leo Park.', polite: true, n: 1 }} />);
    expect(status).toHaveTextContent('');
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_DELAY_MS);
    });
    expect(status).toHaveTextContent('Checked in. Leo Park.');
    expect(alert).toHaveTextContent('');
    rerender(<LiveAnnouncer message={{ text: 'Refused. Voided.', polite: false, n: 2 }} />);
    expect(status).toHaveTextContent('');
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_DELAY_MS);
    });
    expect(alert).toHaveTextContent('Refused. Voided.');
    expect(status).toHaveTextContent('');
    vi.useRealTimers();
  });

  it('reads the same sentence twice when it repeats', () => {
    vi.useFakeTimers();
    const { rerender } = render(<LiveAnnouncer message={{ text: 'Ready.', polite: true, n: 1 }} />);
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_DELAY_MS);
    });
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Ready.');
    rerender(<LiveAnnouncer message={{ text: 'Ready.', polite: true, n: 2 }} />);
    expect(status).toHaveTextContent('');
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_DELAY_MS);
    });
    expect(status).toHaveTextContent('Ready.');
    vi.useRealTimers();
  });
});
