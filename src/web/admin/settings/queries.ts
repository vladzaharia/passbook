import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SettingsListSchema } from '@/shared/contracts/settings-list.ts';
import { api } from '@/web/lib/api.ts';

export const settingsKey = (scope: string) => ['settings', scope] as const;

export function useSettings(scope: string) {
  return useQuery({
    queryKey: settingsKey(scope),
    queryFn: ({ signal }) =>
      api.get('/api/v1/settings', SettingsListSchema, { query: { scope }, signal }),
  });
}

/** Issuer URL of the sign-in provider, once settings have loaded. */
export function useIdpUrl(): string | undefined {
  return useSettings('platform').data?.oidc.issuer;
}

export function useSaveSettings(scope: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (values: Record<string, unknown>) =>
      api.put('/api/v1/settings', SettingsListSchema, { scope, values }),
    onSuccess: (data) => client.setQueryData(settingsKey(scope), data),
  });
}
