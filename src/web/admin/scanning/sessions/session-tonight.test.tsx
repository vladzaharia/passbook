import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { ScanSummarySchema } from '@/shared/contracts/scan-session.ts';
import { formatTime } from '@/web/lib/format.ts';
import { installDomShims } from '@/web/lib/test-utils.tsx';
import { SessionTonight, zoneName } from './session-tonight.tsx';

installDomShims();
afterEach(() => vi.unstubAllGlobals());

const reply = (status: number, body: unknown) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
const show = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SessionTonight sessionId="s1" />
    </QueryClientProvider>,
  );

describe('SessionTonight', () => {
  it('shows the totals, hours, staff and overrides, and passes axe', async () => {
    reply(
      200,
      ScanSummarySchema.parse({
        from: 0,
        to: 1,
        total: 12,
        ok: 10,
        headsUp: 0,
        refused: 2,
        undone: 0,
        byAction: [],
        firstAt: 1,
        lastAt: 2,
        scope: 'session',
        timeZone: 'UTC',
        byHour: [{ start: 3_600_000, label: '01:00', count: 12, refused: 2 }],
        byStaff: [{ staffId: 'a', name: 'Sam', count: 12, overrides: 1, refused: 2 }],
        overrides: {
          count: 1,
          latest: [{ scanId: 'x', at: 1, staffName: 'Sam', approvedBy: 'Alex', reason: 'expired' }],
        },
      }),
    );
    const { container } = show();
    expect(await screen.findByRole('region', { name: 'By staff' })).toHaveTextContent('Sam');
    expect(screen.getByRole('region', { name: 'Overrides' })).toHaveTextContent('Alex');
    expect((await axe(container)).violations).toEqual([]);
  });

  it('names the session zone and labels both hours of a fall-back change', () => {
    expect(zoneName('America/New_York')).toBe('New York time');
    expect(zoneName('UTC')).toBe('UTC');
    expect(zoneName(null)).toBe('your time');
    // New York ends DST on 2026-11-01: 01:00 happens at 05:00Z (EDT) and again at 06:00Z (EST).
    const first = Date.UTC(2026, 10, 1, 5);
    const second = Date.UTC(2026, 10, 1, 6);
    expect(formatTime(first, 'America/New_York')).toBe(formatTime(second, 'America/New_York'));
    expect(formatTime(first, 'America/New_York')).toMatch(/^1:00\s?AM$/);
  });

  it('renders nothing below Manager', async () => {
    reply(403, {
      code: 'SCAN_SUMMARY_SESSION_FORBIDDEN',
      detail: 'Session totals are for Managers.',
      status: 403,
    });
    const { container } = show();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    await vi.waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
