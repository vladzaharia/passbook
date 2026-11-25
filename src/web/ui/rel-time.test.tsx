import { act, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RelTime, useNow } from './rel-time.tsx';

const T0 = Date.UTC(2026, 10, 22, 12, 0, 0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

describe('useNow', () => {
  it('ticks on the interval', () => {
    const { result } = renderHook(() => useNow(1000));
    expect(result.current).toBe(T0);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current).toBe(T0 + 3000);
  });

  it('stops while inactive and keeps its reading', () => {
    const { result } = renderHook(() => useNow(1000, false));
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current).toBe(T0);
  });

  it('stops ticking on unmount', () => {
    const { unmount } = renderHook(() => useNow(1000));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('RelTime', () => {
  it('says just now inside 45 seconds', () => {
    render(<RelTime at={T0 - 30_000} now={T0} />);
    expect(screen.getByText('just now')).toBeInTheDocument();
  });

  it('renders relative text with the exact time in the markup', () => {
    render(<RelTime at={T0 - 5 * 60_000} now={T0} />);
    const el = screen.getByText('5 minutes ago');
    expect(el.tagName).toBe('TIME');
    expect(el).toHaveAttribute('datetime', new Date(T0 - 5 * 60_000).toISOString());
    expect(el).toHaveAttribute('title');
  });

  it('moves on as the clock does', () => {
    function Live() {
      const now = useNow(60_000);
      return <RelTime at={T0} now={now} />;
    }
    render(<Live />);
    expect(screen.getByText('just now')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(180_000);
    });
    expect(screen.getByText('3 minutes ago')).toBeInTheDocument();
  });
});
