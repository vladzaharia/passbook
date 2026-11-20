import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { HistoryItem, HistoryPage } from '../../../../shared/contracts/scan-history.ts';
import type { ScanApi } from '../../api/scan-api.ts';
import { History } from './history.tsx';

const NOW = Date.UTC(2026, 10, 19, 18, 0);
const line = (id: string, over: Partial<HistoryItem> = {}): HistoryItem => ({
  id,
  at: NOW - Number(id) * 60_000,
  event: 'checked_in',
  reason: null,
  label: null,
  place: 'Front desk',
  staff: null,
  amount: null,
  ...over,
});
const page = (items: HistoryItem[], nextCursor: string | null = null): HistoryPage => ({
  items,
  nextCursor,
});
const apiOf = (history: ScanApi['history']) => ({ history }) as unknown as ScanApi;
const view = (api: ScanApi, over: Partial<Parameters<typeof History>[0]> = {}) => (
  <History api={api} passId="p1" zone="UTC" now={NOW} refresh={0} changes {...over} />
);

describe('the record history', () => {
  it('lists lines under their day, newest first, with where and who', async () => {
    const api = apiOf(
      vi.fn(async () =>
        page([
          line('1', { staff: 'Theo B.' }),
          line('2', { event: 'refused', reason: 'guest_visits_used' }),
          line('8000', { event: 'checked_out', place: 'Turnstile A' }),
        ]),
      ),
    );
    render(view(api));
    const rows = await screen.findAllByTestId('op-history-row');
    expect(rows).toHaveLength(3);
    expect(within(rows[0] as HTMLElement).getByText('Checked in')).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText('Front desk · Theo B.')).toBeTruthy();
    expect(screen.getByText('Today')).toBeTruthy();
    expect(screen.getByText('Sat, Nov 14')).toBeTruthy();
  });

  it('re-reads with the filter, and a Door has no Changes', async () => {
    const history = vi.fn(async () => page([line('1')]));
    const api = apiOf(history);
    const { rerender } = render(view(api));
    await screen.findByText('Checked in');
    fireEvent.click(screen.getByRole('radio', { name: 'Visits' }));
    await waitFor(() =>
      expect(history).toHaveBeenLastCalledWith('p1', { filter: 'visits' }, expect.anything()),
    );
    rerender(view(api, { changes: false }));
    expect(screen.queryByRole('radio', { name: 'Changes' })).toBeNull();
  });

  it('shows older lines on request, without repeating one', async () => {
    const history = vi
      .fn()
      .mockResolvedValueOnce(page([line('1'), line('2')], 'c1'))
      .mockResolvedValueOnce(page([line('2'), line('3')], null));
    render(view(apiOf(history)));
    fireEvent.click(await screen.findByRole('button', { name: 'Show older' }));
    await waitFor(() => expect(screen.getAllByTestId('op-history-row')).toHaveLength(3));
    expect(history).toHaveBeenLastCalledWith('p1', { filter: 'all', cursor: 'c1' });
    expect(screen.queryByRole('button', { name: 'Show older' })).toBeNull();
  });

  it('never shows one person under another: a new pass clears the lines at once', async () => {
    let release: (p: HistoryPage) => void = () => undefined;
    const history = vi
      .fn()
      .mockResolvedValueOnce(page([line('1', { staff: 'Theo B.' })]))
      .mockImplementationOnce(() => new Promise<HistoryPage>((r) => (release = r)));
    const api = apiOf(history);
    const { rerender } = render(view(api));
    await screen.findByText('Front desk · Theo B.');
    rerender(view(api, { passId: 'p2' }));
    expect(screen.queryByText('Front desk · Theo B.')).toBeNull();
    expect(screen.queryAllByTestId('op-history-row')).toHaveLength(0);
    await waitFor(() => expect(history).toHaveBeenCalledTimes(2));
    release(page([line('4')]));
    await screen.findByText('Checked in');
  });

  it('says so when there is nothing, and when it cannot load, and retries', async () => {
    const history = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(page([]));
    render(view(apiOf(history)));
    await screen.findByText(/History unavailable/);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('Nothing in the last 30 days.');
  });

  it('keeps what is shown when a refresh fails', async () => {
    const history = vi
      .fn()
      .mockResolvedValueOnce(page([line('1')]))
      .mockRejectedValueOnce(new Error('offline'));
    const api = apiOf(history);
    const { rerender } = render(view(api));
    await screen.findByText('Checked in');
    rerender(view(api, { refresh: 1 }));
    await waitFor(() => expect(history).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Checked in')).toBeTruthy();
  });

  it('copes with an api that has no history call', async () => {
    render(view({} as ScanApi));
    await screen.findByText(/History unavailable/);
  });
});
