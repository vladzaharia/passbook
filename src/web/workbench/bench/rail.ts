import type { ApiRail } from '../../../shared/contracts/developer.ts';

let pending: Promise<{ status: number; body: ApiRail | null }> | undefined;

/** One read of "Your API" per page: the strip shows its key, the log's strip and empty state read the rest. */
export const loadRail = (): Promise<{ status: number; body: ApiRail | null }> => {
  pending ??= fetch('/api/v1/developer/rail', { headers: { accept: 'application/json' } })
    .then(async (res) => ({
      status: res.status,
      body: res.ok ? ((await res.json()) as ApiRail) : null,
    }))
    // Offline or blocked: the strip leaves the key out, the log's strip says it did not load.
    .catch(() => ({ status: 0, body: null }));
  return pending;
};
