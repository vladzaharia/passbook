import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import '../../lib/test-utils.tsx';
import {
  fixtureCard,
  fixtureDisplay,
  fixtureOutcome,
  states,
} from '../machine/fixtures.test-support.ts';
import { fakeDeps } from '../machine/store.test-support.ts';
import { createScanStore } from '../machine/store.ts';
import { ScanStoreContext } from '../machine/use-scan-machine.ts';
import type { ScanRuntime } from '../platform/runtime.ts';
import { DoorDock } from './door-dock.tsx';

const runtime = {
  camera: { hasTorch: () => false, toggleTorch: vi.fn() },
} as unknown as ScanRuntime;
const bundle = { id: 'b1', name: 'Family pack', size: 4, checkedIn: 1 };
const ok = fixtureOutcome('ok', null, {
  card: fixtureCard(),
  display: fixtureDisplay('ok'),
  bundle,
});

function dock(props: Partial<Parameters<typeof DoorDock>[0]> = {}) {
  const store = createScanStore(fakeDeps().deps, states.ready());
  const dispatch = vi.spyOn(store, 'dispatch');
  const wrap = ({ children }: { children: ReactNode }) => (
    <ScanStoreContext.Provider value={store}>{children}</ScanStoreContext.Provider>
  );
  render(
    <DoorDock
      outcome={ok}
      runtime={runtime}
      open={vi.fn()}
      onError={vi.fn()}
      handheld
      {...props}
    />,
    { wrapper: wrap },
  );
  return dispatch;
}

describe('Check in more on the handheld dock', () => {
  it('counts the people left and sends the group with one tap', () => {
    const dispatch = dock();
    fireEvent.click(screen.getByRole('button', { name: 'Check in 3 more' }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'group' });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'dismiss' });
  });

  it('is not on a tablet, where the card carries the chip', () => {
    dock({ handheld: false });
    expect(screen.queryByTestId('dock-group')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
  });

  it('is not offered when everyone is in, or at an Out door', () => {
    dock({ outcome: { ...ok, bundle: { ...bundle, checkedIn: 4 } } });
    expect(screen.queryByTestId('dock-group')).toBeNull();
  });

  it('leaves an Out door alone', () => {
    dock({ direction: { value: 'out' } });
    expect(screen.queryByTestId('dock-group')).toBeNull();
  });
});
