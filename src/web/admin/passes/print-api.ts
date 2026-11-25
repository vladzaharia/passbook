import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PassChannelsResponseSchema } from '@/shared/contracts/channels.ts';
import {
  MintedPrintSchema,
  PassPrintSchema,
  PassPrintsResponseSchema,
} from '@/shared/contracts/prints.ts';
import { api } from '../../lib/api.ts';
import { useMode } from '../../lib/mode.ts';

const base = (passId: string) => `/api/v1/passes/${encodeURIComponent(passId)}`;

const keys = {
  all: ['admin', 'passes', 'print'] as const,
  prints: (passId: string, mode: string) =>
    ['admin', 'passes', 'print', 'list', passId, mode] as const,
  channels: (passId: string, mode: string) =>
    ['admin', 'passes', 'print', 'channels', passId, mode] as const,
};

/** The URL of the staff print page for a pass's active print. */
/** A Test pass carries its mode in the URL: a browser tab cannot send the mode header. */
export const printPageUrl = (passId: string, mode = 'live') =>
  `${base(passId)}/print${mode === 'test' ? '?mode=test' : ''}`;

/** The pass's effective channels; the Print card reads `paper` from it. */
export function usePassPaper(passId: string) {
  const mode = useMode();
  return useQuery({
    queryKey: keys.channels(passId, mode),
    queryFn: ({ signal }) =>
      api.get(`${base(passId)}/channels`, PassChannelsResponseSchema, { signal }),
  });
}

/** Prints, newest first. Never carries a code. */
export function usePassPrints(passId: string) {
  const mode = useMode();
  return useQuery({
    queryKey: keys.prints(passId, mode),
    queryFn: ({ signal }) =>
      api.get(`${base(passId)}/prints`, PassPrintsResponseSchema, { signal }),
  });
}

/** Make or replace a print (`mint`), or void one. Both refresh the card. */
export function usePrintActions(passId: string) {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: keys.all });
  return {
    mint: useMutation({
      mutationFn: () => api.post(`${base(passId)}/prints`, MintedPrintSchema),
      onSuccess: refresh,
    }),
    /** The active print was printed again from the pass as it is now. */
    drawn: useMutation({
      mutationFn: () => api.post(`${base(passId)}/print/drawn`, PassPrintSchema),
      onSuccess: refresh,
    }),
    void: useMutation({
      mutationFn: (printId: string) =>
        api.post(`${base(passId)}/prints/${encodeURIComponent(printId)}/void`, PassPrintSchema),
      onSuccess: refresh,
    }),
  };
}

/** The pass's effective channels (the Channels card reads all six). */
export const usePassChannels = usePassPaper;
