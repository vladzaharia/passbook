import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../lib/test-utils.tsx';
import { SaveBar } from './save-bar.tsx';

const noop = () => {};
const bar = () => screen.queryByRole('region', { name: 'Unsaved changes' });

afterEach(() => {
  vi.useRealTimers();
});

describe('SaveBar phases', () => {
  it('shows Saved with a check after a save, then leaves', () => {
    vi.useFakeTimers();
    const { rerender } = render(<SaveBar dirty onSave={noop} onDiscard={noop} />);
    rerender(<SaveBar dirty saving onSave={noop} onDiscard={noop} />);
    rerender(<SaveBar dirty={false} saving={false} onSave={noop} onDiscard={noop} />);
    expect(bar()).toHaveTextContent('Saved');
    expect(bar()?.querySelector('.wl-check')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(399);
    });
    expect(bar()).toHaveTextContent('Saved');
    // Reduced motion in tests: the bar goes at once instead of sliding down.
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(bar()).toBeNull();
  });

  it('also confirms when saving ends a render before the form resets', () => {
    vi.useFakeTimers();
    const { rerender } = render(<SaveBar dirty saving onSave={noop} onDiscard={noop} />);
    rerender(<SaveBar dirty saving={false} onSave={noop} onDiscard={noop} />);
    rerender(<SaveBar dirty={false} saving={false} onSave={noop} onDiscard={noop} />);
    expect(bar()).toHaveTextContent('Saved');
  });

  it('leaves at once on Discard, and after a failed save', () => {
    vi.useFakeTimers();
    const { rerender } = render(<SaveBar dirty saving onSave={noop} onDiscard={noop} />);
    // The save failed: still dirty. The person then discards.
    rerender(<SaveBar dirty saving={false} onSave={noop} onDiscard={noop} />);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    rerender(<SaveBar dirty={false} onSave={noop} onDiscard={noop} />);
    expect(bar()).toBeNull();
  });

  it('waits for the connection while the save is paused', () => {
    render(<SaveBar dirty saving paused onSave={noop} onDiscard={noop} />);
    const save = screen.getByRole('button', { name: 'Waiting for connection' });
    expect(save).toBeDisabled();
    expect(save).not.toHaveAttribute('aria-busy');
    expect(screen.getByRole('button', { name: 'Discard' })).toBeDisabled();
  });
});
