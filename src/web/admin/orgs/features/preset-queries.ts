import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  EntitlementPresetsSchema,
  type SetEntitlementPresetInput,
  SetEntitlementPresetResultSchema,
} from '@/shared/contracts/entitlement-presets.ts';
import { api } from '@/web/lib/api.ts';
import { isApiError } from '@/web/lib/errors.ts';

const PATH = '/api/v1/platform/entitlement-presets';
const KEY = ['platform', 'entitlement-presets'] as const;

export const usePresets = () =>
  useQuery({
    queryKey: KEY,
    queryFn: ({ signal }) => api.get(PATH, EntitlementPresetsSchema, { signal }),
  });

/** One edit against the revision that was read. A refused edit (409) reloads the presets. */
export function useSetPreset() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: SetEntitlementPresetInput) =>
      api.put(PATH, SetEntitlementPresetResultSchema, input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: KEY });
      // Every org's Features tab and the audit log read what moved.
      void client.invalidateQueries({ queryKey: ['orgs', 'features'] });
      void client.invalidateQueries({ queryKey: ['audit'] });
    },
    onError: (cause) => {
      if (isApiError(cause) && cause.isConflict) void client.invalidateQueries({ queryKey: KEY });
    },
  });
}
