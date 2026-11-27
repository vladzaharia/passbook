import { useQuery } from '@tanstack/react-query';
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
