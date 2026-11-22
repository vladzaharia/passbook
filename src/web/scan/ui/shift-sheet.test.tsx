import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { ScanSummarySchema } from '@/shared/contracts/scan-session.ts';
import { installDomShims } from '../../lib/test-utils.tsx';
import type { ScanApi } from '../api/scan-api.ts';
import { ShiftSheet } from './shift-sheet.tsx';

installDomShims();

const summary = (over: object = {}) =>
  ScanSummarySchema.parse({
    from: 0,
    to: 1,
    total: 12,
    ok: 9,
    headsUp: 1,
    refused: 2,
    undone: 0,
    byAction: [{ actionId: 'in', label: 'Check in', count: 9, amount: 0 }],
    firstAt: 1,
    lastAt: 2,
    timeZone: 'America/New_York',
    // The repeated hour of the clock change is two rows.
    byHour: [
      { start: Date.parse('2026-11-01T05:00:00Z'), label: '01:00', count: 5, refused: 0 },
      { start: Date.parse('2026-11-01T06:00:00Z'), label: '01:00', count: 7, refused: 2 },
    ],
    byValue: [{ kind: 'add', count: 2, amount: 40 }],
    byReason: [{ reason: 'expired', count: 2 }],
    overrides: {
      count: 1,
      latest: [{ scanId: 'a', at: 1, staffName: 'Sam', approvedBy: 'Alex', reason: 'expired' }],
    },
    ...over,
  });

function open(props: Partial<Parameters<typeof ShiftSheet>[0]> = {}) {
  const calls: string[] = [];
  const api = {
    summary: vi.fn(async (_since: number, _call: unknown, scope = 'device') => {
      calls.push(scope);
      return summary(
        scope === 'session'
          ? { scope, byStaff: [{ staffId: 's', name: 'Sam', count: 12, overrides: 1, refused: 2 }] }
          : {},
      );
    }),
  } as unknown as ScanApi;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ShiftSheet
        open
        ending={false}
        api={api}
        since={Date.parse('2026-11-01T04:00:00Z')}
        pending={0}
        onClose={() => undefined}
        onEnd={() => undefined}
        {...props}
      />
    </QueryClientProvider>,
  );
  return calls;
}

describe('ShiftSheet', () => {
  it('leads with the door count and the staff line, as the phone tray does', async () => {
    open({
      counts: {
        today: 312,
        event: { arrived: 312, inside: null, expected: 500, capacity: 500 },
        asOf: 1,
        configRev: 1,
      },
    });
    expect(await screen.findByTestId('shift-you')).toHaveTextContent(
      'You: 9 in · 2 refused · 0 undone',
    );
    expect(screen.getByTestId('shift-count')).toHaveTextContent(/312.*of 500 in/);
  });

  it('shows the shift by action, value, hour and reason, and passes axe', async () => {
    open();
    expect(await screen.findByText('Check in')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Value' })).toHaveTextContent('Added (2)40');
    expect(screen.getByRole('region', { name: 'By hour' }).querySelectorAll('li')).toHaveLength(2);
    expect(screen.getByRole('region', { name: 'Not accepted' })).toHaveTextContent('Expired');
    expect(screen.queryByRole('button', { name: 'This session' })).toBeNull();
    expect((await axe(document.body)).violations).toEqual([]);
  });

  it('lists the overrides for the next person when ending', async () => {
    open({ ending: true });
    const handover = await screen.findByRole('region', { name: 'Handover' });
    expect(handover).toHaveTextContent('1 override this shift.');
    expect(handover).toHaveTextContent('Alex');
    expect((await axe(document.body)).violations).toEqual([]);
  });

  it('gives a Manager the session tab, by staff', async () => {
    const calls = open({ sessionTotals: true });
    await screen.findByText('Check in');
    await userEvent.click(screen.getByRole('button', { name: 'This session' }));
    expect(await screen.findByRole('region', { name: 'By staff' })).toHaveTextContent('Sam');
    expect(calls).toEqual(['device', 'session']);
    expect((await axe(document.body)).violations).toEqual([]);
  });
});
