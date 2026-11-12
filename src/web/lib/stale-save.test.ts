import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/web/lib/errors.ts';
import { handleStaleSave, isStaleSave } from '@/web/lib/stale-save.ts';

vi.mock('@/web/ui/toaster.tsx', () => ({ toast: { info: vi.fn() } }));

describe('stale save', () => {
  it('recognises SETTINGS_CHANGED conflicts only', () => {
    expect(isStaleSave(new ApiError({ status: 409, code: 'SETTINGS_CHANGED' }))).toBe(true);
    expect(isStaleSave(new ApiError({ status: 409, code: 'conflict' }))).toBe(false);
    expect(isStaleSave(new Error('x'))).toBe(false);
  });

  it('refetches once and reports handled for a stale save, and ignores other errors', () => {
    const refetch = vi.fn();
    expect(handleStaleSave(new ApiError({ status: 409, code: 'SETTINGS_CHANGED' }), refetch)).toBe(
      true,
    );
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(handleStaleSave(new ApiError({ status: 500, code: 'server_error' }), refetch)).toBe(
      false,
    );
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
