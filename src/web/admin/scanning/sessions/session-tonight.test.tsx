import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { ScanSummarySchema } from '@/shared/contracts/scan-session.ts';
import { installDomShims } from '@/web/lib/test-utils.tsx';
import { hourLabel, SessionTonight } from './session-tonight.tsx';
import { zoneName } from './zone-name.ts';

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
        byType: [
          { templateId: 't1', name: 'Day pass', count: 8 },
          { templateId: 't2', name: 'Monthly', count: 2 },
        ],
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
    const types = screen.getByRole('region', { name: 'By pass type' });
    expect(types).toHaveTextContent('Day pass');
    expect(types).toHaveTextContent('Monthly');
    expect((await axe(container)).violations).toEqual([]);
  });

  it('names the session zone and tells the two hours of a fall-back change apart', () => {
    expect(zoneName('America/New_York')).toBe('New York time');
    expect(zoneName('UTC')).toBe('UTC');
    expect(zoneName(null)).toBe('your time');
    expect(zoneName('Etc/GMT+5')).toBe('GMT-5 time');
    // New York ends DST on 2026-11-01: 01:00 happens at 05:00Z (EDT) and again at 06:00Z (EST).
    const first = Date.UTC(2026, 10, 1, 5);
    const second = Date.UTC(2026, 10, 1, 6);
    const hours = [{ start: first }, { start: second }];
    expect(hourLabel(first, 'America/New_York', hours)).toMatch(/^1:00\s?AM EDT$/);
    expect(hourLabel(second, 'America/New_York', hours)).toMatch(/^1:00\s?AM EST$/);
    // An ordinary hour stays bare.
    expect(hourLabel(Date.UTC(2026, 10, 1, 8), 'America/New_York', [{ start: first }])).toMatch(
      /^3:00\s?AM$/,
    );
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
