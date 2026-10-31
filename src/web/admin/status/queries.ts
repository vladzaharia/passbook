import { useQuery } from '@tanstack/react-query';
import type { z } from 'zod';
import {
  type ComponentStatusSchema,
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
  verified: 4,
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

export function useWorkflowRuns() {
  return useQuery({
    queryKey: ['status', 'workflows'],
    queryFn: ({ signal }) => api.get('/api/v1/status/workflows', WorkflowRunListSchema, { signal }),
    staleTime: 15_000,
  });
}
