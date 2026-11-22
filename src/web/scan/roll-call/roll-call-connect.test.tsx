import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '../../lib/test-utils.tsx';
import { call, fakeRollCall, person } from './roll-call-fake.test-support.ts';
import { useRollCall } from './use-roll-call.ts';

describe('useRollCall connect', () => {
  it('opens one socket when the caller passes a new connect function on every render', async () => {
    const port = fakeRollCall(call([person(0), person(1)]));
    const open = vi.fn((_options: unknown) => ({ close: vi.fn() }));
    const h = renderHook(() =>
      useRollCall({
        port,
        enabled: true,
        online: true,
        by: '',
        connect: ((opts: unknown) => open(opts)) as never,
      }),
    );
    await waitFor(() => expect(h.result.current.call).not.toBeNull());
    expect(open).toHaveBeenCalledTimes(1);
  });
});
