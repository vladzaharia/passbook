import { type UseQueryResult, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import { SettingsListSchema } from '@/shared/contracts/settings-list.ts';
import { api } from '@/web/lib/api.ts';

const OrgSettingsListSchema = SettingsListSchema.omit({ oidc: true });

export const settingsKey = (scope: string) => ['settings', scope] as const;

export function useSettings(scope: 'platform'): UseQueryResult<z.infer<typeof SettingsListSchema>>;
export function useSettings(scope: string): UseQueryResult<z.infer<typeof OrgSettingsListSchema>>;
export function useSettings(scope: string) {
  return useQuery({
    queryKey: settingsKey(scope),
    queryFn: ({ signal }) =>
      api.get(
        '/api/v1/settings',
        scope === 'platform' ? SettingsListSchema : OrgSettingsListSchema,
        {
          query: { scope },
          signal,
        },
      ),
  });
}

/** Issuer URL of the sign-in provider, once settings have loaded. */
export function useIdpUrl(): string | undefined {
  return useSettings('platform').data?.oidc.issuer;
}

export function useSaveSettings(scope: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (values: Record<string, unknown>) => {
      // The revision the form was loaded with: a save from older values is a 409 (handleStaleSave).
      const loaded = client.getQueryData<{ configRevision?: number }>(settingsKey(scope));
      return api.put(
        '/api/v1/settings',
        scope === 'platform' ? SettingsListSchema : OrgSettingsListSchema,
        {
          scope,
          values,
          ...(loaded?.configRevision === undefined
            ? {}
            : { configRevision: loaded.configRevision }),
        },
      );
    },
    onSuccess: (data) => client.setQueryData(settingsKey(scope), data),
  });
}
