import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/errors.ts';
import type { ScanApi } from '../api/scan-api.ts';
import { FlipSheet } from './flip-sheet.tsx';
import { RoleUnlock } from './unlock-sheet.tsx';

const apiWith = (setRole: ReturnType<typeof vi.fn>) => ({ setRole }) as unknown as ScanApi;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('device flip client', () => {
  it('asks the server to show the customer screen, then reloads the session', async () => {
    const setRole = vi.fn().mockResolvedValue({});
    const refetch = vi.fn().mockResolvedValue(undefined);
    render(<FlipSheet open api={apiWith(setRole)} refetch={refetch} onClose={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Show to customer' })[0] as Element);
    });
    expect(setRole).toHaveBeenCalledWith({ role: 'customer' });
    expect(refetch).toHaveBeenCalled();
  });

  it('holds before asking, and opens the PIN sheet when the server wants one', async () => {
    const setRole = vi
      .fn()
      .mockRejectedValue(new ApiError({ status: 403, code: 'UNLOCK_REQUIRED' }));
    render(<RoleUnlock api={apiWith(setRole)} refetch={vi.fn()} />);
    const hold = screen.getByRole('button', { name: 'Hold to switch back' });
    fireEvent.pointerDown(hold);
    fireEvent.pointerUp(hold);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(setRole).not.toHaveBeenCalled();
    fireEvent.pointerDown(hold);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(setRole).toHaveBeenCalledWith({ role: 'scan' });
    expect(screen.getByText('Back to scanning?')).toBeTruthy();
  });
});

describe('change mode', () => {
  it('says where the other modes are set', () => {
    render(<FlipSheet open api={apiWith(vi.fn())} refetch={vi.fn()} onClose={() => {}} />);
    expect(screen.getByText(/set by an admin/)).toBeTruthy();
    expect(screen.getByText('Change mode')).toBeTruthy();
  });
});
