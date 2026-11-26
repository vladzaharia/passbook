import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StatusChip, toneOfState, toneOfStatus } from './status-chip.tsx';
import { BenchTime, benchTimeText } from './time.tsx';
import { benchZone, resetBenchZone, setBenchZone } from './zone.ts';

// Signed out: the zone stays where the test puts it.
beforeEach(() =>
  vi.stubGlobal('fetch', async () => new Response('{"authenticated":false}', { status: 200 })),
);
afterEach(() => {
  cleanup();
  resetBenchZone();
  vi.unstubAllGlobals();
});

// 2026-11-25 22:15:53 UTC: 14:15:53 in Seattle, 07:15:53 on Nov 26 in Tokyo.
const AT = Date.UTC(2026, 10, 25, 22, 15, 53);
const LATER = AT + 60 * 60_000;

describe('bench time', () => {
  it('reads a row in the org zone: the clock today, the day and minute otherwise, never UTC', () => {
    expect(benchTimeText(AT, 'America/Los_Angeles', 'auto', LATER)).toBe('14:15:53');
    expect(benchTimeText(AT, 'Asia/Tokyo', 'auto', LATER)).toBe('07:15:53');
    // A day earlier in Berlin: no longer today there, so the date shows.
    expect(benchTimeText(AT - 86_400_000, 'Europe/Berlin', 'auto', LATER)).toBe('Nov 24, 23:15');
    // Each zone keeps its own calendar for "today".
    const tokyoMorning = Date.UTC(2026, 10, 26, 2);
    expect(benchTimeText(AT, 'Asia/Tokyo', 'auto', tokyoMorning)).toBe('07:15:53');
    expect(benchTimeText(AT, 'America/Los_Angeles', 'auto', tokyoMorning)).toBe('14:15:53');
  });

  it('names the zone in full and says relative times for last used and expires', () => {
    expect(benchTimeText(AT, 'America/Los_Angeles', 'full')).toBe('Nov 25, 2026, 2:15:53 PM PST');
    expect(benchTimeText(AT, 'Asia/Tokyo', 'full')).toBe('Nov 26, 2026, 7:15:53 AM GMT+9');
    expect(benchTimeText(AT, 'UTC', 'ago', AT + 2 * 60_000)).toBe('2 minutes ago');
    expect(benchTimeText(AT + 3 * 86_400_000, 'UTC', 'until', AT)).toBe('in 3 days');
  });

  it('draws a machine-readable <time> with the full moment as its tooltip, in the sandbox zone', () => {
    setBenchZone('Asia/Tokyo');
    expect(benchZone()).toBe('Asia/Tokyo');
    render(<BenchTime at={AT} now={LATER} />);
    const t = screen.getByText('07:15:53');
    expect(t.tagName).toBe('TIME');
    expect(t.getAttribute('datetime')).toBe('2026-11-25T22:15:53.000Z');
    expect(t.getAttribute('title')).toBe('Nov 26, 2026, 7:15:53 AM GMT+9');
    // The session names another zone: the time redraws.
    act(() => setBenchZone('America/New_York'));
    expect(screen.getByText('17:15:53')).toBeTruthy();
    // No zone known: the default, Seattle, never the browser's or UTC.
    act(() => setBenchZone(null));
    expect(screen.getByText('14:15:53')).toBeTruthy();
  });
});

describe('the status chip', () => {
  it('has one vocabulary: 2xx success, 1xx and 3xx info, 4xx warning, 5xx danger, none neutral', () => {
    expect([200, 204, 101, 302, 404, 422, 500, 503, null, 0].map(toneOfStatus)).toEqual([
      'success',
      'success',
      'info',
      'info',
      'warning',
      'warning',
      'danger',
      'danger',
      'neutral',
      'neutral',
    ]);
    expect(['delivered', 'failed', 'pending', 'paused'].map(toneOfState)).toEqual([
      'success',
      'danger',
      'neutral',
      'neutral',
    ]);
  });

  it('shows the number and names the reason; a state shows its words, never a dash', () => {
    const { container } = render(
      <>
        <StatusChip status={422} />
        <StatusChip status={null} tone="neutral">
          Pending
        </StatusChip>
      </>,
    );
    const [http, state] = [...container.querySelectorAll('.bench-sc')];
    expect(http?.textContent).toBe('422');
    expect(http?.getAttribute('data-tone')).toBe('warning');
    expect(http?.getAttribute('title')).toBe('422 Unprocessable');
    expect(state?.textContent).toBe('Pending');
    expect(state?.getAttribute('title')).toBeNull();
  });
});
