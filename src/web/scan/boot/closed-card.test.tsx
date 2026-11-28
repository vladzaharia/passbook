import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import { SCAN_COPY } from '../../../shared/copy/scan.ts';
import { managedSession } from '../../admin/scanning/sessions/test-fixtures.ts';
import { ApiError } from '../../lib/errors.ts';
import type { ScanApi } from '../api/scan-api.ts';
import { ClosedCard } from './closed-card.tsx';
import { sessionFixture } from './session.test-support.ts';

// A fixed morning, so "opens in 3 hours" is always today (after 21:00 UTC it would be tomorrow).
const NOW = Date.UTC(2026, 10, 19, 9, 0);
const opensAt = NOW + 3 * 3_600_000;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});
function closed(over: Partial<ScanSession> = {}, at: number | null = opensAt): ScanSession {
  const workspace = {
    session: {
      ...managedSession,
      timeZone: 'UTC',
      window: { open: false, by: 'hours' as const, opensAt: at, closesAt: null },
    },
    device: managedSession.devices[0],
  } as unknown as NonNullable<ScanSession['workspace']>;
  return sessionFixture({ workspace, ...over });
}
function mount(session: ScanSession, openNow = vi.fn(async () => ({}))) {
  const refetch = vi.fn(async () => undefined);
  render(
    <ClosedCard session={session} api={{ openNow } as unknown as ScanApi} refetch={refetch} />,
  );
  return { openNow, refetch };
}

describe('Closed screen', () => {
  it('says closed and when it opens, in the session zone', () => {
    mount(closed());
    expect(screen.getByRole('heading', { name: SCAN_COPY.closed.headline })).toBeTruthy();
    expect(screen.getByText(/^Opens \d{1,2}:\d\d [AP]M/)).toBeTruthy();
    expect(screen.getByRole('button', { name: SCAN_COPY.actions.tryAgain })).toBeTruthy();
  });
  it('says so when nothing opens', () => {
    mount(closed({}, null));
    expect(screen.getByText(SCAN_COPY.closed.noOpening)).toBeTruthy();
  });
  it('lets a signed-in manager open now, then reloads', async () => {
    const { openNow, refetch } = mount(
      closed({ staff: { id: 's1', name: 'Mo', role: 'manager' }, staffList: [] }),
    );
    await userEvent.click(screen.getByRole('button', { name: SCAN_COPY.closed.openNow }));
    await waitFor(() => expect(refetch).toHaveBeenCalled());
    expect(openNow).toHaveBeenCalledWith({});
  });
  it('asks anyone else for a manager code', async () => {
    const { openNow } = mount(
      closed({ staff: { id: 's2', name: 'Al', role: 'door' }, staffList: null }),
    );
    await userEvent.click(screen.getByRole('button', { name: SCAN_COPY.closed.openNow }));
    expect(openNow).not.toHaveBeenCalled();
    expect(screen.getByText(SCAN_COPY.managerCode.title)).toBeTruthy();
  });
  it('shows a refusal without opening', async () => {
    const openNow = vi.fn(async () => {
      throw new ApiError({ status: 403, code: 'SESSION_OPEN_FORBIDDEN' });
    });
    mount(closed({ principal: 'admin' }), openNow as never);
    await userEvent.click(screen.getByRole('button', { name: SCAN_COPY.closed.openNow }));
    expect(await screen.findByText(SCAN_COPY.closed.managerOnly)).toBeTruthy();
  });
  it('announces the screen politely', async () => {
    mount(closed());
    const live = await screen.findByRole('status');
    await waitFor(() => expect(live.textContent).toMatch(/^Closed\. Opens /));
  });
  it('says already open and reloads on a lost race', async () => {
    const openNow = vi.fn(async () => {
      throw new ApiError({ status: 409, code: 'SCANNING_SESSION_OPEN' });
    });
    const { refetch } = mount(closed({ principal: 'admin' }), openNow as never);
    await userEvent.click(screen.getByRole('button', { name: SCAN_COPY.closed.openNow }));
    expect(await screen.findByText(SCAN_COPY.closed.alreadyOpen)).toBeTruthy();
    expect(refetch).toHaveBeenCalled();
  });
});
