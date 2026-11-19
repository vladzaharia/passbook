import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import {
  BulkPassChannelsResponseSchema,
  type BulkPassChannelsSchema,
  PassChannelsResponseSchema,
  type PutPassChannelsSchema,
} from '@/shared/contracts/channels.ts';
import { api } from '../../lib/api.ts';
import { passKeys } from './api.ts';

type PassChange = z.input<typeof PutPassChannelsSchema>['channels'];
type BulkBody = z.input<typeof BulkPassChannelsSchema>;

/** Override channels for one pass; `null` returns a channel to its template. */
export function usePutPassChannels(passId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (channels: PassChange) =>
      api.put(`/api/v1/passes/${encodeURIComponent(passId)}/channels`, PassChannelsResponseSchema, {
        channels,
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
