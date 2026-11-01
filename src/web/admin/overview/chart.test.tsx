import { act, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chartGeometry, LineChart, niceMax, ticks } from './chart.tsx';
import { resetShownCounts, useRememberedCount } from './count.ts';
import { daysUntil, formatRelative } from './format.ts';

const series = (vals: number[]) =>
  vals.map((v, i) => ({ t: 1_700_000_000_000 + i * 86_400_000, v }));

describe('chart helpers', () => {
  it('rounds the axis maximum to 1, 2 or 5 steps', () => {
    expect([0, 1, 3, 7, 12, 480, 1001].map(niceMax)).toEqual([2, 2, 5, 10, 20, 500, 2000]);
  });
  it('labels only whole-number ticks', () => {
    expect(ticks(2).map((t) => t.label)).toEqual(['2', '1', '0']);
    expect(ticks(5).map((t) => t.label)).toEqual(['5', null, '0']);
  });
  it('maps points into the plot as fractions', () => {
    const g = chartGeometry(series([0, 10]));
    expect(g.max).toBe(10);
    expect(g.fx).toEqual([0, 1]);
    expect(g.fy).toEqual([1, 0]);
    expect(g.line.startsWith('M')).toBe(true);
    expect(g.area.endsWith('Z')).toBe(true);
  });
  it('handles empty and single-point series', () => {
    expect(chartGeometry([]).line).toBe('');
    expect(chartGeometry([{ t: 5, v: 3 }]).fx).toEqual([0.5]);
  });
});

describe('line chart', () => {
  it('summarizes the series for screen readers and reads out the hovered point', async () => {
    render(<LineChart title="Issued" points={series([1, 3, 2])} range="7d" />);
    const plot = screen.getByRole('img', { name: /Issued: 6 total, peak 3/ });
    const box = plot.parentElement as HTMLElement;
    box.getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, height: 80 }) as DOMRect;
    await userEvent.setup().pointer({ target: box, coords: { clientX: 99, clientY: 10 } });
    expect(box.querySelector('.wl-guide')).not.toBeNull();
    expect(screen.getByText(/: 2$/)).toBeInTheDocument();
  });
  it('clips in only when asked and says when a series is not available', () => {
    const { container, rerender } = render(
      <LineChart title="Issued" points={series([1, 2])} range="7d" enter />,
    );
    expect(container.querySelectorAll('.wl-chart-clip')).toHaveLength(1);
    rerender(<LineChart title="Issued" points={series([1, 2])} range="7d" />);
    expect(container.querySelector('.wl-chart-clip')).toBeNull();
    rerender(<LineChart title="Downloads" points={series([0, 0])} range="7d" unavailable />);
    expect(screen.getByText('Not available')).toBeInTheDocument();
  });
  it('crossfades to new data instead of re-entering', () => {
    const { container, rerender } = render(
      <LineChart title="Issued" points={series([1, 2])} range="7d" />,
    );
    rerender(<LineChart title="Issued" points={series([4, 1, 2])} range="30d" />);
    expect(container.querySelector('.wl-chart-out')).not.toBeNull();
    expect(container.querySelector('.wl-chart-in')).not.toBeNull();
  });
  it('swaps the plot for a table with Show data', () => {
    render(<LineChart title="Issued" points={series([1, 2])} range="7d" showData />);
    expect(screen.getByRole('table', { name: 'Issued' })).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});

describe('remembered counts', () => {
  const real = window.matchMedia;
  afterEach(() => {
    window.matchMedia = real;
    resetShownCounts();
    vi.restoreAllMocks();
  });
  const motion = () => {
    window.matchMedia = ((media: string) => ({
      matches: false,
      media,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof matchMedia;
  };

  it('never starts a frame loop for 0 to 0', () => {
    motion();
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    const { result } = renderHook(() => useRememberedCount('t-zero', 0));
    expect(result.current).toBe(0);
    expect(raf).not.toHaveBeenCalled();
  });
  it('counts from the last value shown, so a revisit starts at its value', () => {
    motion();
    let frame: FrameRequestCallback = () => {};
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frame = cb;
      return 1;
    });
    const first = renderHook(() => useRememberedCount('t-rev', 40));
    expect(first.result.current).toBe(0);
    act(() => frame(performance.now() + 1000));
    expect(first.result.current).toBe(40);
    first.unmount();
    const again = renderHook(() => useRememberedCount('t-rev', 40));
    expect(again.result.current).toBe(40);
  });
  it('shows the value at once under reduced motion', () => {
    const { result } = renderHook(() => useRememberedCount('t-rm', 12));
    expect(result.current).toBe(12);
  });
});

describe('format helpers', () => {
  it('formats relative times and day counts', () => {
    expect(formatRelative(0, 2 * 86_400_000)).toMatch(/2 days ago/);
    expect(daysUntil(3 * 86_400_000 + 5, 0)).toBe(3);
    expect(daysUntil(0, 86_400_000 * 2 - 1)).toBe(-2);
  });
});
