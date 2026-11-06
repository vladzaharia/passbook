import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import { pageOf } from '@/shared/contracts/common.ts';
import {
  CreatedScannerSetupSchema,
  type CreateScannerSetupSchema,
  type UpdateScannerSetupSchema,
} from '@/shared/contracts/scan-setups.ts';
import {
  ScanEventSchema,
  ScannerPairingSchema,
  ScannerPairingStateSchema,
  TerminalTokenSchema,
} from '@/shared/contracts/scanners.ts';
import { TemplateListSchema } from '@/shared/contracts/templates.ts';
import { api } from '@/web/lib/api.ts';
import { scanningKeys } from './queries.ts';

/** Console scanners write API (SA 5.2). The list and detail reads live in queries.ts. */
const base = (id: string) => `/api/v1/scanners/${encodeURIComponent(id)}`;

/** Pairing polls every 2 s while the face is open and the tab is visible. */
export const PAIRING_POLL_MS = 2000;

export function useCreateScanner() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: z.input<typeof CreateScannerSetupSchema>) =>
      api.post('/api/v1/scan-setups', CreatedScannerSetupSchema, body),
    onSuccess: () => client.invalidateQueries({ queryKey: scanningKeys.scanners }),
  });
}

export function useUpdateScanner(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: z.input<typeof UpdateScannerSetupSchema>) =>
      api.action('PATCH', `/api/v1/scan-setups/${encodeURIComponent(id)}`, body),
    onSuccess: () => client.invalidateQueries({ queryKey: scanningKeys.scanners }),
  });
}

/** A new code replaces any live one. */
export function useNewPairing(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post(`${base(id)}/pairing`, ScannerPairingSchema),
    onSuccess: () => client.invalidateQueries({ queryKey: scanningKeys.pairing(id) }),
  });
}

/** Waiting until the scanner pairs or the code expires; stops when hidden (react-query pauses). */
export function usePairingState(id: string, active: boolean, pollMs = PAIRING_POLL_MS) {
  return useQuery({
    queryKey: scanningKeys.pairing(id),
    queryFn: ({ signal }) => api.get(`${base(id)}/pairing`, ScannerPairingStateSchema, { signal }),
    enabled: active,
    refetchInterval: active ? pollMs : false,
    staleTime: 0,
    gcTime: 0,
  });
}

/** Pair the admin's own browser: sets the scanner cookie here. */
export function usePairHere(id: string) {
  return useMutation({ mutationFn: () => api.action('POST', `${base(id)}/pair-here`) });
}

function useScannerAction(id: string, path: string, body?: unknown) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.action('POST', `${base(id)}/${path}`, body),
    onSuccess: () => client.invalidateQueries({ queryKey: scanningKeys.scanners }),
  });
}

export const useRevokeScanner = (id: string) => useScannerAction(id, 'revoke');
/** Go live / Move to Test mode. */
export const useScannerMode = (id: string, mode: 'live' | 'test') =>
  useScannerAction(id, 'mode', { mode });

/** A till's token: shown once; asking again replaces it. */
export function useReplaceToken(id: string) {
  return useMutation({ mutationFn: () => api.post(`${base(id)}/token`, TerminalTokenSchema) });
}

const EventListSchema = pageOf(ScanEventSchema);

/** Upcoming and live events first: the picker for "An event" and the name behind a scanner's Accepts. */
export function useScanEvents(orgId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['admin', 'scanning', 'events', 'options', orgId ?? null],
    queryFn: ({ signal }) =>
      api.get('/api/v1/scan-events', EventListSchema, { query: { orgId, limit: 200 }, signal }),
    enabled,
    staleTime: 60_000,
  });
}

export function useOrgTemplates(orgId: string | undefined) {
  return useQuery({
    queryKey: ['admin', 'scanning', 'templates', orgId ?? null],
    queryFn: ({ signal }) =>
      api.get('/api/v1/templates', TemplateListSchema, { query: { orgId, limit: 200 }, signal }),
    enabled: Boolean(orgId),
    staleTime: 60_000,
  });
}
