import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import {
  BulkPassChannelsResponseSchema,
  type BulkPassChannelsSchema,
  PassChannelsResponseSchema,
  type PutPassChannelsSchema,
} from '@/shared/contracts/channels.ts';
import { api } from '../../lib/api.ts';
import { useDebounced } from '../../lib/debounce.ts';
import { passKeys } from './api.ts';

type PassChange = z.input<typeof PutPassChannelsSchema>['channels'];
interface PassChannelsChange {
  channels: PassChange;
  /** Also issue a new scan code ("Turn off and replace codes"). */
  replaceCodes?: boolean;
}
type BulkBody = z.input<typeof BulkPassChannelsSchema>;

/** Override channels for one pass; `null` returns a channel to its template. */
export function usePutPassChannels(passId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ channels, replaceCodes }: PassChannelsChange) =>
      api.put(`/api/v1/passes/${encodeURIComponent(passId)}/channels`, PassChannelsResponseSchema, {
        channels,
        ...(replaceCodes ? { replaceCodes: true } : {}),
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: passKeys.all }),
  });
}

/** On, off or reset for up to 100 selected passes. */
export function useBulkPassChannels() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: BulkBody) =>
      api.post('/api/v1/passes/bulk/channels', BulkPassChannelsResponseSchema, body),
    onSuccess: () => client.invalidateQueries({ queryKey: passKeys.all }),
  });
}

/** What a bulk change would do, asked again whenever the choice changes. Writes nothing. */
export function useBulkChannelsPreview(choice: BulkBody, enabled: boolean) {
  // Ticking boxes quickly asks once, 300 ms after the last change.
  const body = useDebounced(choice, 300);
  return useQuery({
    queryKey: ['admin', 'passes', 'bulk-channels-preview', body] as const,
    queryFn: ({ signal }) =>
      api.post(
        '/api/v1/passes/bulk/channels',
        BulkPassChannelsResponseSchema,
        {
          ...body,
          dryRun: true,
        },
        { signal },
      ),
    // The choice that was last settled, not the one still being typed.
    enabled: enabled && body.action === 'off' && body.channels.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 0,
    gcTime: 0,
  });
}
