import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import { type Mode, pageOf } from '@/shared/contracts/common.ts';
import type { UpdateScannerSetupSchema } from '@/shared/contracts/scan-setups.ts';
import {
  ScanEventSchema,
  ScannerPairingSchema,
  ScannerPairingStateSchema,
  TerminalTokenSchema,
} from '@/shared/contracts/scanners.ts';
import { EligibleTemplateListSchema } from '@/shared/contracts/template-releases.ts';
import { TemplateListSchema } from '@/shared/contracts/templates.ts';
import { api } from '@/web/lib/api.ts';
import { useMode } from '@/web/lib/mode.ts';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import { scanningKeys } from './queries.ts';

/** Console scanners write API (SA 5.2). The list and detail reads live in queries.ts. */
const base = (id: string) => `/api/v1/scanners/${encodeURIComponent(id)}`;

/** Pairing polls every 2 s while the face is open and the tab is visible. */
export const PAIRING_POLL_MS = 2000;

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
  const scope = useOrgScope();
  const allowed = Boolean(
    enabled &&
      !scope.isLoading &&
      !scope.isError &&
      orgId &&
      orgId === scope.orgId &&
      scope.membership?.capabilities.includes('scanning:read'),
  );
  return useQuery({
    queryKey: ['admin', 'scanning', 'events', 'options', allowed ? orgId : null, allowed],
    queryFn: ({ signal }) => {
      if (!allowed || !orgId) throw new Error('Choose an authorized organization.');
      return api.get('/api/v1/scan-events', EventListSchema, {
        query: { orgId, limit: 200 },
        signal,
      });
    },
    select: (page) => ({ ...page, items: page.items.filter((event) => event.orgId === orgId) }),
    enabled: allowed,
    staleTime: 60_000,
  });
}

export function useOrgTemplates(orgId: string | undefined) {
  const scope = useOrgScope();
  const allowed = Boolean(
    !scope.isLoading &&
      !scope.isError &&
      orgId &&
      orgId === scope.orgId &&
      scope.membership?.capabilities.includes('templates:read'),
  );
  return useQuery({
    queryKey: ['admin', 'scanning', 'templates', allowed ? orgId : null, allowed],
    queryFn: ({ signal }) => {
      if (!allowed || !orgId) throw new Error('Choose an authorized organization.');
      return api.get('/api/v1/templates', TemplateListSchema, {
        query: { orgId, limit: 200 },
        signal,
      });
    },
    select: (page) => ({
      ...page,
      items: page.items.filter((template) => template.orgId === null || template.orgId === orgId),
    }),
    enabled: allowed,
    staleTime: 60_000,
  });
}

/** Approved Apple releases eligible for the selected organization and console mode. */
export function useEligibleTemplates(
  orgId: string | undefined,
  enabled = true,
  resourceMode?: Mode,
) {
  const scope = useOrgScope();
  const mode = useMode();
  const allowed = Boolean(
    enabled &&
      !scope.isLoading &&
      !scope.isError &&
      orgId &&
      orgId === scope.orgId &&
      (!resourceMode || resourceMode === mode) &&
      scope.membership?.capabilities.includes('scanning:read') &&
      (scope.membership.capabilities.includes('templates:read') ||
        scope.membership.capabilities.includes('passes:read')),
  );
  return useInfiniteQuery({
    queryKey: [
      'admin',
      'templates',
      'eligible',
      'scanning',
      allowed ? orgId : null,
      mode,
      'apple',
      allowed,
    ],
    enabled: allowed,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => {
      if (!allowed || !orgId) throw new Error('Choose an authorized organization and mode.');
      return api.get('/api/v1/templates/eligible', EligibleTemplateListSchema, {
        query: { orgId, mode, provider: 'apple', cursor: pageParam, limit: 200 },
        signal,
      });
    },
    select: (data) => ({
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        items: page.items.filter(
          (item) => item.templateOrgId === null || item.templateOrgId === orgId,
        ),
      })),
    }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 0,
    refetchOnMount: 'always',
  });
}
