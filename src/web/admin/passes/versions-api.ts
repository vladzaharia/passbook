import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { PassDetailSchema } from '@/shared/contracts/passes.ts';
import { api } from '../../lib/api.ts';
import { passKeys } from './api.ts';

/** A retained version, for rendering. Disabled while `version` is undefined. */
export function usePassVersion(id: string, version: number | undefined) {
  return useQuery({
    queryKey: passKeys.version(id, version ?? -1),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/passes/${id}/versions/${version}`, PassDetailSchema, { signal }),
    enabled: version !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

const DiffSchema = z.object({
  changes: z.array(z.object({ path: z.string(), from: z.unknown(), to: z.unknown() })),
});

export function usePassDiff(id: string, from: number | undefined, to: number | undefined) {
  return useQuery({
    queryKey: ['admin', 'passes', 'diff', id, from, to],
    queryFn: ({ signal }) =>
      api.get(`/api/v1/passes/${id}/diff`, DiffSchema, { query: { from, to }, signal }),
    enabled: from !== undefined && to !== undefined && from !== to,
    staleTime: Number.POSITIVE_INFINITY,
  });
}
