import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnonBlueprint } from './blueprint.ts';
import { useLivePass } from './use-live-pass.ts';

vi.mock('./live-plan.ts', () => {
  throw new Error('chunk');
});

const blueprint = {
  preview: { id: 'p1', passJson: { a: 1 }, sample: { name: 'Alex' } },
} as unknown as AnonBlueprint;

describe('useLivePass', () => {
  afterEach(() => vi.restoreAllMocks());

  it('clears the failure notice when values return to the stored sample', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { result, rerender } = renderHook(({ values }) => useLivePass(blueprint, values), {
      initialProps: { values: { name: 'Alex' } as Record<string, unknown> },
    });
    expect(result.current.failed).toBe(false);
    rerender({ values: { name: 'x' } });
    await waitFor(() => expect(result.current.failed).toBe(true));
    rerender({ values: { name: 'Alex' } });
    await waitFor(() => expect(result.current.failed).toBe(false));
  });
});
