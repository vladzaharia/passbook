import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { OkSchema } from '@/shared/contracts/common.ts';
import { HoldListSchema, ReceiptListSchema } from '@/shared/contracts/retention.ts';
import { api } from '@/web/lib/api.ts';

/** Org pages call the org routes with the member's capabilities; platform pages the admin routes. */
export type RetentionScope = 'org' | 'platform';

export const retentionBase = (scope: RetentionScope, orgId: string) =>
  scope === 'org'
    ? `/api/v1/orgs/${encodeURIComponent(orgId)}/retention`
    : `/api/v1/platform/orgs/${encodeURIComponent(orgId)}/retention`;

const key = (scope: RetentionScope, orgId: string, what: 'holds' | 'receipts') =>
  ['retention', scope, orgId, what] as const;

export function useHolds(scope: RetentionScope, orgId: string, enabled = true) {
  return useQuery({
    queryKey: key(scope, orgId, 'holds'),
    enabled,
    queryFn: ({ signal }) =>
      api.get(`${retentionBase(scope, orgId)}/holds`, HoldListSchema, { signal }),
  });
}

export function useReceipts(scope: RetentionScope, orgId: string, enabled = true) {
  return useQuery({
    queryKey: key(scope, orgId, 'receipts'),
    enabled,
    queryFn: ({ signal }) =>
      api.get(`${retentionBase(scope, orgId)}/receipts`, ReceiptListSchema, { signal }),
  });
}

export function usePlaceHold(scope: RetentionScope, orgId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { passId?: string | null; reason: string }) =>
      api.post(`${retentionBase(scope, orgId)}/holds`, OkSchema, body),
    onSuccess: () => client.invalidateQueries({ queryKey: key(scope, orgId, 'holds') }),
  });
}

export function useReleaseHold(scope: RetentionScope, orgId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (holdId: string) =>
      api.post(
        `${retentionBase(scope, orgId)}/holds/${encodeURIComponent(holdId)}/release`,
        OkSchema,
        {},
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: key(scope, orgId, 'holds') }),
  });
}
