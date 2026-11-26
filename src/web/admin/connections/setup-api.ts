import { useQuery } from '@tanstack/react-query';
import { ArrivalListSchema } from '@/shared/contracts/connection-arrivals.ts';
import { ConnectionSetupSchema, SetupGuideSchema } from '@/shared/contracts/connection-setup.ts';
import { api } from '../../lib/api.ts';
import type { ArrivalLoader } from '../../ui/webhook-setup/index.ts';
import { connectionKeys } from './api.ts';

/** The sender's guide with this connection's URL filled in. Never holds the secret. */
export function useConnectionSetup(id: string | undefined) {
  return useQuery({
    queryKey: [...connectionKeys.detail(id ?? ''), 'setup'],
    queryFn: ({ signal }) =>
      api.get(`/api/v1/connections/${id}/setup`, ConnectionSetupSchema, { signal }),
    enabled: Boolean(id),
    staleTime: 0,
  });
}

/** A sender's guide before any connection exists: its name, who makes the secret, what to subscribe to. */
export function useRecipeSetup(recipe: string | undefined) {
  return useQuery({
    queryKey: [...connectionKeys.connectors, 'setup', recipe],
    queryFn: ({ signal }) =>
      api.get(`/api/v1/connectors/webhook-push/recipes/${recipe}/setup`, SetupGuideSchema, {
        signal,
      }),
    enabled: Boolean(recipe),
    staleTime: 5 * 60_000,
  });
}

/** Reads the arrival ledger for the live check: rows seen or counted again after `since`. */
export const arrivalLoader =
  (id: string): ArrivalLoader =>
  async (since) => {
    const page = await api.get(`/api/v1/connections/${id}/webhook-arrivals`, ArrivalListSchema, {
      query: { since },
    });
    return { rows: page.items };
  };
