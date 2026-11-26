import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import type { z } from 'zod';
import {
  IdentityRunSchema,
  PlatformDefaultResultSchema,
  PlatformIdentityListSchema,
  type PlatformIdentitySchema,
} from '@/shared/contracts/identities.ts';
import {
  IdentityMoveArmedSchema,
  IdentityMoveListSchema,
  IdentityMovePreviewSchema,
  type IdentityMoveRequestSchema,
} from '@/shared/contracts/identity-moves.ts';
import { OperationSchema } from '@/shared/contracts/operations.ts';
import { api, listQuery } from '@/web/lib/api.ts';
import { trackOperation } from '@/web/ui/operation/index.ts';

export type PlatformIdentity = z.infer<typeof PlatformIdentitySchema>;
export type MoveRequest = z.infer<typeof IdentityMoveRequestSchema>;
export type Slot = 'root' | 'devtest';

const KEY = ['identities', 'platform'] as const;
const IDENTITIES = '/api/v1/platform/apple/identities';
const MOVES = '/api/v1/platform/apple/identity-moves';
const ACTIVE = ['queued', 'running', 'waiting'];

/** One Idempotency-Key per distinct request: a retry of the same one replays, a new one starts anew. */
function useIdempotencyKey() {
  const held = useRef<{ for: string; key: string }>(undefined);
  return (request: string) => {
    if (held.current?.for !== request) held.current = { for: request, key: crypto.randomUUID() };
    return { 'idempotency-key': held.current.key };
  };
}

/** The platform's identities; refreshes itself while a setup run is open. */
export function usePlatformIdentities() {
  return useQuery({
    queryKey: KEY,
    queryFn: ({ signal }) => api.get(IDENTITIES, PlatformIdentityListSchema, { signal }),
    refetchInterval: (q) => (q.state.data?.openRuns.length ? 4000 : false),
  });
}

/** One setup run, polled until it ends; a finished run refreshes the list once. */
export function useSetupRun(runId: string | null) {
  const client = useQueryClient();
  return useQuery({
    queryKey: ['identities', 'runs', 'one', runId],
    enabled: runId !== null,
    queryFn: async ({ signal }) => {
      const run = await api.get(
        `/api/v1/identity-runs/${encodeURIComponent(runId ?? '')}`,
        IdentityRunSchema,
        { signal },
      );
      if (!ACTIVE.includes(run.state)) void client.invalidateQueries({ queryKey: KEY });
      return run;
    },
    refetchInterval: (q) => (q.state.data && !ACTIVE.includes(q.state.data.state) ? false : 3000),
  });
}

export function useStartPlatformSlot() {
  const client = useQueryClient();
  const headers = useIdempotencyKey();
  return useMutation({
    mutationFn: (slot: Slot) =>
      api.post(IDENTITIES, IdentityRunSchema, { slot }, { headers: headers(slot) }),
    onSuccess: () => client.invalidateQueries({ queryKey: KEY }),
  });
}

export function useMakeDefault(id: string) {
  const client = useQueryClient();
  const headers = useIdempotencyKey();
  return useMutation({
    mutationFn: () =>
      api.post(
        `${IDENTITIES}/${encodeURIComponent(id)}/default`,
        PlatformDefaultResultSchema,
        {},
        { headers: headers(id) },
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: ['identities'] }),
  });
}

export function useMovePreview(request: MoveRequest | null) {
  return useQuery({
    queryKey: [...KEY, 'move-preview', request],
    enabled: request !== null,
    retry: false,
    queryFn: ({ signal }) =>
      api.get(`${MOVES}/preview`, IdentityMovePreviewSchema, {
        query: {
          orgId: request?.orgId ?? '',
          fromIdentityId: request?.fromIdentityId ?? '',
          ...(request?.toIdentityId ? { toIdentityId: request.toIdentityId } : {}),
        },
        signal,
      }),
  });
}

export function useStartMove() {
  const client = useQueryClient();
  const headers = useIdempotencyKey();
  return useMutation({
    mutationFn: async (request: MoveRequest) => {
      const op = await api.post(MOVES, OperationSchema, request, {
        headers: headers(JSON.stringify(request)),
      });
      trackOperation(op);
      return op;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: [...KEY, 'moves'] }),
  });
}

/** Move rows of one org, newest first; each carries its state and why it is kept or unarmed. */
export function useMoves(orgId: string | null, operationId?: string) {
  return useQuery(
    listQuery({
      queryKey: [...KEY, 'moves', orgId, operationId ?? ''],
      enabled: orgId !== null,
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.get(MOVES, IdentityMoveListSchema, {
          query: { orgId: orgId ?? '', ...(operationId ? { operationId } : {}), limit: 100 },
          signal,
        }),
      refetchInterval: 8000,
    }),
  );
}

export function useArmMove() {
  const client = useQueryClient();
  const headers = useIdempotencyKey();
  return useMutation({
    mutationFn: (moveId: string) =>
      api.post(
        `${MOVES}/${encodeURIComponent(moveId)}/arm`,
        IdentityMoveArmedSchema,
        {},
        { headers: headers(moveId) },
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: [...KEY, 'moves'] }),
  });
}
