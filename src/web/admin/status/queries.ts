import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import {
  type ComponentStatusSchema,
  IncidentListSchema,
  type OpenIncidentSchema,
  PublicIncidentSchema,
  StatusResponseSchema,
  WorkflowRunListSchema,
} from '@/shared/contracts/status.ts';
import { api } from '@/web/lib/api.ts';

type Component = z.infer<typeof ComponentStatusSchema>;

const SEVERITY: Record<Component['state'], number> = {
  failing: 0,
  degraded: 1,
  not_configured: 2,
  configured: 3,
  not_in_use: 4,
  verified: 5,
};

/** Worst first; ties keep label order. */
export function sortBySeverity<T extends Pick<Component, 'state' | 'label'>>(
  items: readonly T[],
): T[] {
  return [...items].sort(
    (a, b) => SEVERITY[a.state] - SEVERITY[b.state] || a.label.localeCompare(b.label),
  );
}

export function useStatus() {
  return useQuery({
    queryKey: ['status'],
    queryFn: ({ signal }) => api.get('/api/v1/status', StatusResponseSchema, { signal }),
    staleTime: 15_000,
  });
}

/** Recheck skips the server's short cache; the runs reload with it. */
export function useRecheck() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.get('/api/v1/status', StatusResponseSchema, { query: { fresh: '1' } }),
    onSuccess: (data) => {
      client.setQueryData(['status'], data);
      void client.invalidateQueries({ queryKey: ['status', 'workflows'], exact: true });
    },
  });
}

export function useWorkflowRuns() {
  return useQuery({
    queryKey: ['status', 'workflows'],
    queryFn: ({ signal }) => api.get('/api/v1/status/workflows', WorkflowRunListSchema, { signal }),
    staleTime: 15_000,
  });
}

const INCIDENTS = '/api/v1/status/incidents';

export function useIncidents() {
  return useQuery({
    queryKey: ['status', 'incidents'],
    queryFn: ({ signal }) => api.get(INCIDENTS, IncidentListSchema, { signal }),
    staleTime: 15_000,
  });
}

export function useOpenIncident() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: z.input<typeof OpenIncidentSchema>) =>
      api.post(INCIDENTS, PublicIncidentSchema, body),
    onSuccess: () => client.invalidateQueries({ queryKey: ['status', 'incidents'] }),
  });
}

export function useResolveIncident() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post(`${INCIDENTS}/${encodeURIComponent(id)}/resolve`, PublicIncidentSchema),
    onSuccess: () => client.invalidateQueries({ queryKey: ['status', 'incidents'] }),
  });
}
