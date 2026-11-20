import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Visitor } from '../../../shared/contracts/visitors.ts';
import { ThemeProvider } from '../../lib/theme.tsx';
import type { ScanApi } from '../api/scan-api.ts';
import VisitorsHost from './visitors-host.tsx';

const NOW = Date.now();
const visitor = (over: Partial<Visitor>): Visitor => ({
  id: 'v1',
  passId: 'p1',
  name: 'Leo Park',
  hostName: 'Ana Ruiz',
  windowFrom: NOW,
  windowUntil: NOW + 3_600_000,
  note: 'Gate code 4411',
  status: 'in',
  statusAt: NOW,
  autoOut: false,
  hasEmail: false,
  ...over,
});

function setup(items: Visitor[]) {
  const api = {
    visitors: vi.fn(async () => ({ items })),
    signOutPerson: vi.fn(async () => ({ passId: 'p1', stayMs: 60_000, tag: 'none' as const })),
  };
  render(
    <ThemeProvider>
      <VisitorsHost api={api as unknown as ScanApi} open online onClose={() => undefined} />
    </ThemeProvider>,
  );
  return api;
}

describe('Desk visitors', () => {
  it('lists the day with host and desk note, and offers Check out only for people who are in', async () => {
    setup([
      visitor({}),
      visitor({
        id: 'v2',
        passId: 'p2',
        name: 'Mia Stone',
        status: 'expected',
        statusAt: null,
        note: null,
      }),
    ]);
    const sheet = await screen.findByRole('dialog', { name: 'Visitors' });
    expect(await within(sheet).findByText('Leo Park')).toBeInTheDocument();
    expect(within(sheet).getByText(/Gate code 4411/)).toBeInTheDocument();
    expect(within(sheet).getAllByRole('button', { name: 'Check out' })).toHaveLength(1);
  });

  it('signs the visitor out with a fresh key and refreshes the list', async () => {
    const user = userEvent.setup();
    const api = setup([visitor({})]);
    await user.click(await screen.findByRole('button', { name: 'Check out' }));
    await waitFor(() => expect(api.signOutPerson).toHaveBeenCalledTimes(1));
    expect(api.signOutPerson).toHaveBeenCalledWith({
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
      passId: 'p1',
      tag: 'none',
    });
    await waitFor(() => expect(api.visitors).toHaveBeenCalledTimes(2));
  });

  it('says so when nobody is expected', async () => {
    setup([]);
    expect(await screen.findByText('No visitors today')).toBeInTheDocument();
  });
});
