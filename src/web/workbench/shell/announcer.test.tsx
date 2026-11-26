import { act, render, renderHook, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnnouncerProvider, createAnnouncer, HOLD_MS, useAnnounce } from './announcer.tsx';
import { markSeen, SEEN_DWELL_MS, useArrive, useSeenMarks, useSeenOnView } from './attention.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe('the announcement queue (US6)', () => {
  it('speaks in turn, never one over another', () => {
    const said: string[] = [];
    const { announce } = createAnnouncer((t) => said.push(t));
    announce('Logs');
    announce('Now in Northwind, Test');
    expect(said).toEqual(['Logs']);
    vi.advanceTimersByTime(HOLD_MS);
    expect(said).toEqual(['Logs', 'Now in Northwind, Test']);
  });

  it('paces a keyed message to one per window, keeping only the newest that waited', () => {
    let now = 0;
    const said: string[] = [];
    const { announce } = createAnnouncer(
      (t) => said.push(t),
      () => now,
    );
    announce('1 new request', { key: 'rows', every: 5000 });
    announce('2 new requests', { key: 'rows', every: 5000 });
    announce('3 new requests', { key: 'rows', every: 5000 });
    expect(said).toEqual(['1 new request']);
    now = 5000;
    vi.advanceTimersByTime(5000);
    expect(said).toEqual(['1 new request', '3 new requests']);
  });

  it('takes a hint back out of the region after its time', () => {
    const said: string[] = [];
    const { announce } = createAnnouncer((t) => said.push(t));
    announce('Go to…', { clearAfter: 1200 });
    vi.advanceTimersByTime(1200);
    expect(said).toEqual(['Go to…', '']);
  });

  it('renders one polite region for the shell', () => {
    function Speaker() {
      const announce = useAnnounce();
      useEffect(() => announce('Events'), [announce]);
      return null;
    }
    render(
      <AnnouncerProvider>
        <Speaker />
      </AnnouncerProvider>,
    );
    const regions = screen.getAllByRole('status');
    expect(regions).toHaveLength(1);
    expect(regions[0]).toHaveAttribute('aria-live', 'polite');
    expect(regions[0]).toHaveTextContent('Events');
  });
});

describe('attention', () => {
  it('arrives once when a count rises, never on the first value, a fall or a repeat', () => {
    const { result, rerender } = renderHook(({ v }: { v: number | undefined }) => useArrive(v), {
      initialProps: { v: undefined as number | undefined },
    });
    rerender({ v: 3 });
    expect(result.current).toBe(0);
    rerender({ v: 3 });
    rerender({ v: 1 });
    expect(result.current).toBe(0);
    rerender({ v: 4 });
    expect(result.current).toBe(1);
  });

  it('keeps seen marks per org and area, only moving forward', () => {
    const { result } = renderHook(() => useSeenMarks('org_1'));
    expect(result.current).toEqual({});
    act(() => markSeen('org_1', 'logs', 200));
    expect(result.current).toEqual({ logs: 200 });
    act(() => markSeen('org_1', 'logs', 100));
    expect(result.current).toEqual({ logs: 200 });
    act(() => markSeen('org_2', 'events', 50));
    expect(result.current).toEqual({ logs: 200 });
    expect(SEEN_DWELL_MS).toBe(1000);
  });

  it('marks an area seen once its newest row has been in view for a second', () => {
    let fire: (entries: { isIntersecting: boolean }[]) => void = () => undefined;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: typeof fire) {
          fire = cb;
        }
        observe() {}
        disconnect() {}
      },
    );
    const row = document.createElement('div');
    renderHook(() => useSeenOnView('org_3', 'inbox', row, 900));
    const marks = renderHook(() => useSeenMarks('org_3'));
    act(() => fire([{ isIntersecting: true }]));
    act(() => vi.advanceTimersByTime(SEEN_DWELL_MS - 1));
    expect(marks.result.current).toEqual({});
    act(() => fire([{ isIntersecting: false }]));
    act(() => vi.advanceTimersByTime(SEEN_DWELL_MS));
    expect(marks.result.current).toEqual({});
    act(() => fire([{ isIntersecting: true }]));
    act(() => vi.advanceTimersByTime(SEEN_DWELL_MS));
    expect(marks.result.current).toEqual({ inbox: 900 });
    vi.unstubAllGlobals();
  });
});
