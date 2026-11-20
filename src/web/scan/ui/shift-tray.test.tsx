import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { ScanSummarySchema } from '@/shared/contracts/scan-session.ts';
import { installDomShims } from '../../lib/test-utils.tsx';
import type { ScanApi } from '../api/scan-api.ts';
import { ShiftSheet } from './shift-sheet.tsx';

installDomShims();

const summary = ScanSummarySchema.parse({
  from: 0,
  to: 1,
  total: 140,
  ok: 128,
  headsUp: 3,
  refused: 9,
  undone: 3,
  byAction: [{ actionId: 'in', label: 'Check in', count: 128, amount: 0 }],
  firstAt: 1,
  lastAt: 2,
  timeZone: 'UTC',
  byHour: [],
  byValue: [],
  byReason: [],
  overrides: { count: 0, latest: [] },
});
const counts = {
  today: 312,
  event: { arrived: 312, inside: null, expected: 500, capacity: 500 },
  asOf: 1,
  configRev: 1,
};

afterEach(() => vi.restoreAllMocks());

function phone(props: Partial<Parameters<typeof ShiftSheet>[0]> = {}) {
  const real = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    ...real(query),
    matches: query.includes('max-width: 639'),
  })) as typeof window.matchMedia;
  const api = { summary: vi.fn(async () => summary) } as unknown as ScanApi;
  const onEnding = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ShiftSheet
        open
        ending={false}
        api={api}
        since={0}
        pending={0}
        counts={counts}
        onEnding={onEnding}
        onClose={() => undefined}
        onEnd={() => undefined}
        {...props}
      />
    </QueryClientProvider>,
  );
  return onEnding;
}

describe('This shift on a handheld', () => {
  it('is the 560 tray: the count with its bar, what you did, one End shift', async () => {
    const onEnding = phone();
    expect(await screen.findByTestId('shift-you')).toHaveTextContent(
      'You: 128 in · 9 refused · 3 undone',
    );
    expect(screen.getByTestId('shift-count')).toHaveTextContent('312 of 500 in');
    expect(document.querySelector('.scan-pass-sheet[data-tray]')).not.toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'End shift' }));
    expect(onEnding).toHaveBeenCalled();
    expect((await axe(document.body)).violations).toEqual([]);
  });

  it('keeps every other total one tap down', async () => {
    phone();
    expect(await screen.findByText('All numbers')).toBeVisible();
    expect(document.querySelector('details.scan-tray-more')).not.toHaveAttribute('open');
  });

  it('asks before ending: Keep scanning, End shift, held while scans are unconfirmed', async () => {
    phone({ ending: true, pending: 2 });
    expect(await screen.findByRole('button', { name: 'Keep scanning' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'End shift' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('2 scans need confirmation');
  });
});
