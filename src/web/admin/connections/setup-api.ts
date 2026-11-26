import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { ArrivalListSchema } from '@/shared/contracts/connection-arrivals.ts';
import { ConnectionSetupSchema, SetupGuideSchema } from '@/shared/contracts/connection-setup.ts';
import { api } from '../../lib/api.ts';
import type { ArrivalLoader } from '../../ui/webhook-setup/index.ts';
import { connectionKeys, useWebhookFailures } from './api.ts';

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

/** What a real delivery is, in the plural, from the recipe's id: "shopify-orders" is orders. */
export const recordNoun = (recipe: string): string =>
  recipe === 'custom' ? 'records' : recipe.split('-').slice(1).join(' ') || 'records';

/** Event refs of accepted deliveries whose work failed or is blocked: PassBook read them, nothing was issued. */
export function useNotIssued(connectionId: string): ReadonlySet<string> {
  const failures = useWebhookFailures(connectionId, true, 4000);
  return useMemo(
    () =>
      new Set(
        (failures.data?.items ?? [])
          .filter((f) => f.state === 'failed' || f.state === 'blocked')
          .map((f) => f.eventRef),
      ),
    [failures.data],
  );
}

/** "In Shopify: row menu, **Send test**." The test line led by the provider, where it says where. */
export function testLine(text: string, provider: string, kind: string): string {
  if (kind === 'cli' || kind === 'snippet') return text;
  return `In ${provider}: ${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}
