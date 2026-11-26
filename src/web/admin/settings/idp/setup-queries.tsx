import { useMutation, useQuery } from '@tanstack/react-query';
import { SetupStatusSchema, type StartSetup } from '@/shared/contracts/idp-setup.ts';
import { StartedOperationSchema } from '@/shared/contracts/operations.ts';
import { api } from '@/web/lib/api.ts';
import { ApiError } from '@/web/lib/errors.ts';
import { trackOperation } from '@/web/ui/operation/index.ts';
import { IDP_KEY } from '../../idp/status-queries.ts';

const BASE = '/api/v1/platform/idp';

/** The item matrix. One Polaris ID read, so it stays fresh for 30 s. */
export function useSetupStatus(enabled = true) {
  return useQuery({
    queryKey: [...IDP_KEY, 'setup'],
    queryFn: ({ signal }) => api.get(`${BASE}/setup`, SetupStatusSchema, { signal }),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

/** The binding says it cannot be reached: the card is not shown. */
export const isUnavailable = (error: unknown): boolean =>
  error instanceof ApiError && error.code === 'IDP_UNAVAILABLE';

/** Preview and apply answer 202 with an operation the page follows; so does the token rotation. */
async function start(path: string, body: object) {
  const { operation } = await api.post(`${BASE}${path}`, StartedOperationSchema, body);
  trackOperation(operation);
  return operation;
}

export function useSetupActions() {
  return {
    setup: useMutation({ mutationFn: (body: StartSetup) => start('/setup', body) }),
    rotate: useMutation({
      mutationFn: (dryRun: boolean) => start('/scim-token/rotate', { dryRun }),
    }),
  };
}
