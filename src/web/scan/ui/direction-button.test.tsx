import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import '../../lib/test-utils.tsx';
import { states } from '../machine/fixtures.test-support.ts';
import { fakeDeps } from '../machine/store.test-support.ts';
import { createScanStore } from '../machine/store.ts';
import { ScanStoreContext } from '../machine/use-scan-machine.ts';
import type { ScanRuntime } from '../platform/runtime.ts';
import { Capsule } from './capsule.tsx';
import { DirectionButton } from './direction-button.tsx';
import { DoorDock } from './door-dock.tsx';

const runtime = {
  camera: { hasTorch: () => true, toggleTorch: vi.fn() },
} as unknown as ScanRuntime;

function dock(
  direction: { value: 'auto' | 'in' | 'out'; onCycle?: () => void } | undefined,
  handheld = true,
) {
  const store = createScanStore(fakeDeps().deps, states.ready());
  const wrap = ({ children }: { children: ReactNode }) => (
    <ScanStoreContext.Provider value={store}>{children}</ScanStoreContext.Provider>
  );
  return render(
    <DoorDock
      outcome={null}
      runtime={runtime}
      open={vi.fn()}
      onError={vi.fn()}
      handheld={handheld}
      direction={direction}
    />,
    { wrapper: wrap },
  );
}

describe('the direction button', () => {
  it('shows the way it reads, fills for Out and asks for the next stop', async () => {
    const onCycle = vi.fn();
    const { container, rerender } = render(<DirectionButton value="auto" onCycle={onCycle} />);
    const button = screen.getByRole('button', { name: 'Direction: Auto' });
    expect(button).toHaveAttribute('data-variant', 'gray');
    fireEvent.click(button);
    expect(onCycle).toHaveBeenCalled();
    rerender(<DirectionButton value="out" onCycle={onCycle} />);
    expect(screen.getByRole('button', { name: 'Direction: Out' })).toHaveAttribute(
      'data-variant',
      'filled',
    );
    expect((await axe(container)).violations).toEqual([]);
  });

  it('sits in the thumb row of a Both scanner on a handheld, ahead of the torch', () => {
    const onCycle = vi.fn();
    dock({ value: 'in', onCycle });
    const row = screen.getByTestId('dock-direction');
    fireEvent.click(row);
    expect(onCycle).toHaveBeenCalled();
    expect(row.nextElementSibling).toHaveAccessibleName('Torch');
  });

  it('is left out of a fixed In or Out door and of a tablet', () => {
    dock({ value: 'out' });
    expect(screen.queryByTestId('dock-direction')).toBeNull();
  });
  it('is left out of a tablet', () => {
    dock({ value: 'in', onCycle: vi.fn() }, false);
    expect(screen.queryByTestId('dock-direction')).toBeNull();
  });
});

describe('the state line', () => {
  it('adds the direction after the state', () => {
    render(<Capsule name="Front door" state="scanning" mode="Door" direction="Out" />);
    expect(screen.getByText(/Scanning · Out/)).toBeVisible();
  });
});
