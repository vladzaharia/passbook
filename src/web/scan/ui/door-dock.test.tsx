import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import '../../lib/test-utils.tsx';
import { exit, full, grant, heldIn, heldOut } from '../machine/access-fixtures.test-support.ts';
import { fixtureOutcome, states } from '../machine/fixtures.test-support.ts';
import { fakeDeps } from '../machine/store.test-support.ts';
import { createScanStore } from '../machine/store.ts';
import { ScanStoreContext } from '../machine/use-scan-machine.ts';
import type { ScanRuntime } from '../platform/runtime.ts';
import { DoorDock } from './door-dock.tsx';

const runtime = {
  camera: { hasTorch: () => false, toggleTorch: vi.fn() },
} as unknown as ScanRuntime;

function dock(
  outcome: ReturnType<typeof grant> | null,
  inside?: { count: number; onOpen: () => void },
) {
  const store = createScanStore(fakeDeps().deps, states.ready());
  const dispatch = vi.spyOn(store, 'dispatch');
  const wrap = ({ children }: { children: ReactNode }) => (
    <ScanStoreContext.Provider value={store}>{children}</ScanStoreContext.Provider>
  );
  render(
    <DoorDock
      outcome={outcome}
      runtime={runtime}
      open={vi.fn()}
      onError={vi.fn()}
      inside={inside}
    />,
    { wrapper: wrap },
  );
  return dispatch;
}

function DockProbe({ outcome }: { outcome: ReturnType<typeof grant> }) {
  const store = createScanStore(fakeDeps().deps, states.ready());
  return (
    <ScanStoreContext.Provider value={store}>
      <DoorDock outcome={outcome} runtime={runtime} open={vi.fn()} onError={vi.fn()} />
    </ScanStoreContext.Provider>
  );
}

describe('the dock under a verdict', () => {
  it('a turnaround hold offers Tap out and Done', () => {
    const dispatch = dock(heldIn());
    expect(screen.queryByRole('button', { name: /Let in/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Tap out' }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'turn', direction: 'out' });
    expect(screen.getByRole('button', { name: 'Done' })).toBeVisible();
  });
  it('an already-out hold offers Tap in', () => {
    const dispatch = dock(heldOut());
    fireEvent.click(screen.getByRole('button', { name: 'Tap in' }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'turn', direction: 'in' });
  });
  it('a full zone offers Let in, which overrides the scan', () => {
    const dispatch = dock(full());
    fireEvent.click(screen.getByRole('button', { name: 'Let in' }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'override', actionId: 'access' });
  });
  it('an event hold keeps Let in', () => {
    dock(
      fixtureOutcome('heads_up', 'already_done', {
        action: { id: 'check_in', label: 'Check in', kind: 'check_in' },
      }),
    );
    expect(screen.getByRole('button', { name: 'Let in' })).toBeVisible();
  });
  it('says Let in for a first entry and Let in only for a repeat', () => {
    const cases = [
      ['capacity_full', 'Let in'],
      ['not_yet_valid', 'Let in'],
      ['ended', 'Let in'],
      ['cooldown', 'Let in'],
      ['already_done', 'Let in'],
      ['still_inside', 'Let in'],
    ] as const;
    for (const [reason, label] of cases) {
      const { unmount } = render(
        <DockProbe
          outcome={fixtureOutcome('heads_up', reason, {
            action: { id: 'check_in', label: 'Check in', kind: 'check_in' },
          })}
        />,
      );
      expect(screen.getByTestId('dock-let-in'), reason).toHaveTextContent(label);
      unmount();
    }
  });
  it('names the action on a check hold, not a check-in', () => {
    dock(
      fixtureOutcome('heads_up', 'check_required', {
        action: { id: 'add_stamp', label: 'Add stamp', kind: 'add' },
      }),
    );
    expect(screen.getByRole('button', { name: 'Add stamp' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Check in' })).toBeNull();
  });
  it('a grant and an exit show Look up (the strip carries Undo), not a hold verb', () => {
    for (const o of [grant(), exit()]) {
      dock(o);
    }
    expect(screen.queryByRole('button', { name: /Tap|Let in/ })).toBeNull();
  });
});

describe("Who's in on the dock", () => {
  it('shows with the live count when ready, and opens', () => {
    const onOpen = vi.fn();
    dock(null, { count: 42, onOpen });
    const button = screen.getByTestId('scan-inside-open');
    expect(button).toHaveTextContent("Who's in");
    expect(button).toHaveTextContent('42');
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalled();
  });
  it('is absent without a place', () => {
    dock(null);
    expect(screen.queryByTestId('scan-inside-open')).toBeNull();
  });
});

void act;
