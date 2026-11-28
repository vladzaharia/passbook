import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../lib/test-utils.tsx';
import { LiveCheck, TwoSided } from './index.ts';
import { TOPICS } from './test-support.test-support.tsx';

const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const MIN = 60_000;

/** A viewport the test can resize: every query listener hears the change. */
function viewport(initial: number) {
  let width = initial;
  const listeners = new Set<() => void>();
  const matches = (query: string) => {
    const max = /max-width:\s*([\d.]+)px/.exec(query)?.[1];
    const min = /min-width:\s*([\d.]+)px/.exec(query)?.[1];
    return max ? width <= Number(max) : min ? width >= Number(min) : false;
  };
  window.matchMedia = ((query: string) => ({
    get matches() {
      return matches(query);
    },
    media: query,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return (to: number) => {
    width = to;
    act(() => {
      for (const fn of listeners) fn();
    });
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('the live check across a resize', () => {
  it('keeps its 3 and 15 minute clocks and what it saw when the layout changes shape', async () => {
    const resize = viewport(1440);
    const load = vi.fn(async () => ({ rows: [], etag: undefined }));
    render(
      <TwoSided
        guide={<LiveCheck mode="listen" provider="Shopify" load={load} since={0} topics={TOPICS} />}
        panel={<p>panel</p>}
        strip={<span>strip</span>}
      />,
    );
    await tick(2 * MIN);
    expect(screen.getByRole('heading', { name: 'Listening · nothing yet' })).toBeInTheDocument();

    // Across the phone breakpoint the tree is another one: the clock goes on, it does not restart.
    resize(500);
    await tick(1.5 * MIN);
    expect(screen.getByRole('heading', { name: 'Nothing arrived yet' })).toBeInTheDocument();

    resize(834);
    await tick(12 * MIN);
    expect(screen.getByRole('heading', { name: 'Paused listening' })).toBeInTheDocument();

    // A paused panel stays paused when the layout changes: it does not poll again.
    const calls = load.mock.calls.length;
    resize(1440);
    await tick(MIN);
    expect(screen.getByRole('heading', { name: 'Paused listening' })).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(calls);
  });
});
