import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { OkSchema } from '@/shared/contracts/common.ts';
import {
  type NewVisitor,
  type Visitor,
  VisitorListSchema,
  VisitorSchema,
} from '@/shared/contracts/visitors.ts';
import { api } from '../../lib/api.ts';
import { localZone } from '../../lib/timezones.ts';
import { localDay } from '../../lib/visitors.ts';

export type VisitTab = 'today' | 'upcoming' | 'past';

const keys = {
  all: ['admin', 'visitors'] as const,
  list: (orgId: string, tab: VisitTab, dayStart: number) =>
    ['admin', 'visitors', orgId, tab, dayStart] as const,
};

export function useVisitors(orgId: string, tab: VisitTab) {
  const day = useMemo(() => localDay(), []);
  return useQuery({
    queryKey: keys.list(orgId, tab, day.start),
    queryFn: ({ signal }) =>
      api.get('/api/v1/visitors', VisitorListSchema, {
        query: { orgId, tab, dayStart: day.start, dayEnd: day.end },
        signal,
      }),
    // Arrivals happen at the door: keep the list fresh without a reload.
    refetchInterval: 30_000,
  });
}

function useRefresh() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: keys.all });
}

export function useNewVisitor(orgId: string) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (body: Omit<NewVisitor, 'orgId'>) =>
      api.post('/api/v1/visitors', VisitorSchema, { ...body, orgId }),
    onSuccess: refresh,
  });
}

export function useVisitorAction(orgId: string, action: 'check-out' | 'cancel') {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (v: Pick<Visitor, 'id'>) =>
      api.post(`/api/v1/visitors/${encodeURIComponent(v.id)}/${action}`, VisitorSchema, undefined, {
        query: { orgId },
      }),
    onSuccess: refresh,
  });
}

export function useResendHostEmail(orgId: string) {
  return useMutation({
    mutationFn: (v: Pick<Visitor, 'id'>) =>
      api.post(
        `/api/v1/visitors/${encodeURIComponent(v.id)}/host-email`,
        OkSchema,
        { timeZone: localZone() },
        { query: { orgId } },
      ),
  });
}

export function useResendInvite() {
  return useMutation({
    mutationFn: (v: Pick<Visitor, 'passId'>) =>
      api.post(`/api/v1/passes/${encodeURIComponent(v.passId)}/resend-email`, OkSchema, {}),
  });
}
