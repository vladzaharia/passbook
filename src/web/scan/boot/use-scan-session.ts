/**
 * The scan session: pairing link first, then `GET /scan/session`. It refetches on visible, on
 * online and every 5 minutes, and between scans when the counts carry a new `configRev`.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import { isApiError } from '../../lib/errors.ts';
import type { ScanApi } from '../api/scan-api.ts';
import { toFail } from '../api/to-fail.ts';
import type { ScanState } from '../machine/types.ts';
import { takePairCode } from './pair-link.ts';

const REFETCH_MS = 5 * 60_000;
const KEY = ['scan', 'session'] as const;

/** The CSRF secret lives here, in memory only: never in storage, never in a URL. */
export function createCsrfHolder() {
  let token: string | undefined;
  return {
    get: () => token,
    set: (next: string | null | undefined) => {
      token = next ?? undefined;
    },
  };
}
export type CsrfHolder = ReturnType<typeof createCsrfHolder>;

export type SessionPhase = 'loading' | 'unpaired' | 'ready' | 'blocked' | 'error';

export interface ScanSessionHook {
  phase: SessionPhase;
  session: ScanSession | null;
  /** From `#pair=`, already removed from the address bar. Only the Pair tap posts it. */
  pairCode: string | null;
  /** The block panel behind a `blocked` phase. */
  block: 'revoked' | 'suspended' | 'signed_out' | null;
  pair(code: string): Promise<void>;
  refetch(): Promise<void>;
}

/** A new `configRev` is applied between scans: never under an open card, a drawer or a request. */
export function needsSessionRefetch(session: ScanSession, state: ScanState): boolean {
  if (!state.counts || state.counts.configRev === session.counts.configRev) return false;
  return state.loop.s === 'ready' && state.overlay === null && state.card === null && !state.block;
}

export function useScanSession(
  api: ScanApi,
  csrf: CsrfHolder,
  machine?: ScanState | null,
): ScanSessionHook {
  const client = useQueryClient();
  // Read before the first request: the fragment is gone from the address bar by then.
  const [pairCode] = useState(() => takePairCode());
  const query = useQuery({
    queryKey: KEY,
    queryFn: async () => {
      const session = await api.session();
      csrf.set(session.csrfToken);
      return session;
    },
    refetchInterval: REFETCH_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const session = query.data ?? null;
  const { refetch } = query;

  useEffect(() => {
    if (session && machine && needsSessionRefetch(session, machine)) void refetch();
  }, [session, machine, refetch]);

  const pair = useCallback(
    async (code: string) => {
      const next = await api.pair(code);
      csrf.set(next.csrfToken);
      client.setQueryData(KEY, next);
    },
    [api, csrf, client],
  );
  const again = useCallback(async () => {
    await refetch();
  }, [refetch]);

  let phase: SessionPhase = 'loading';
  let block: ScanSessionHook['block'] = null;
  if (session) phase = 'ready';
  else if (query.isError) {
    const fail = toFail(query.error);
    if (isApiError(query.error) && query.error.code === 'SCANNER_UNAUTHENTICATED')
      phase = 'unpaired';
    else if (
      fail.error === 'revoked' ||
      fail.error === 'suspended' ||
      fail.error === 'signed_out'
    ) {
      phase = 'blocked';
      block = fail.error;
    } else phase = 'error';
  }
  return { phase, session, pairCode, block, pair, refetch: again };
}
