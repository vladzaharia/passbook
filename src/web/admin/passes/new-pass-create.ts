import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import type { OrgMembership } from '@/shared/contracts/org-membership.ts';
import { PassDetailSchema } from '@/shared/contracts/passes.ts';
import type { SessionResponse } from '@/shared/contracts/session.ts';
import { api } from '../../lib/api.ts';
import { isApiError } from '../../lib/errors.ts';
import { getMode } from '../../lib/mode.ts';
import { markMinted } from '../../lib/motion.ts';
import { MEMBERSHIPS_STALE_MS, membershipsQuery, sessionQuery } from '../../lib/session.ts';
import { passKeys } from './api.ts';
import { markCreated } from './created.tsx';
import { fingerprint, newKey } from './format.ts';
import type { FormValues } from './schema-form/index.ts';

export interface NewPassPayload {
  orgId: string;
  templateId: string;
  mode: 'live' | 'test';
  templateVersion: string;
  releaseId: string;
  releaseGeneration: number;
  input: FormValues;
  holderEmail?: string;
  sendEmail: boolean;
}

interface CreatePassIntent {
  payload: NewPassPayload;
  principalId: string;
  firstOfOrg: boolean;
}

/**
 * Creates the pass. The same payload on retry reuses its idempotency key, so a double submit
 * cannot create two. On success the pass's page gets its card (so the preview morphs into it) and
 * the created mark; `firstOfOrg` makes that page celebrate.
 */
export function useCreatePass(
  onCreated: (id: string, orgId: string, principalId: string) => void,
  onConflict: (payload: NewPassPayload, principalId: string) => void,
) {
  const qc = useQueryClient();
  const keyRef = useRef<{ fp: string; key: string }>({ fp: '', key: '' });
  const isCurrentPrincipal = (principalId: string) => {
    const state = qc.getQueryState(sessionQuery.queryKey);
    const session = qc.getQueryData<SessionResponse>(sessionQuery.queryKey);
    return (
      state?.status === 'success' &&
      !state.isInvalidated &&
      state.fetchStatus === 'idle' &&
      session?.authenticated === true &&
      session.user.id === principalId
    );
  };
  const grantsFresh = () => {
    const query = qc.getQueryCache().find({ queryKey: membershipsQuery.queryKey, exact: true });
    return (
      query?.state.status === 'success' &&
      query.state.fetchStatus === 'idle' &&
      !query.isStaleByTime(MEMBERSHIPS_STALE_MS)
    );
  };
  const confirmReady = async (principalId: string) => {
    // A session refresh can begin while grants are being fetched (and vice versa).
    // Join each in-flight refresh and recheck both before settling the result.
    for (;;) {
      const state = qc.getQueryState(sessionQuery.queryKey);
      const session = qc.getQueryData<SessionResponse>(sessionQuery.queryKey);
      if (state?.status !== 'success' || !session?.authenticated || session.user.id !== principalId)
        return false;
      if (state.fetchStatus === 'fetching' || state.isInvalidated) {
        try {
          await qc.fetchQuery({ ...sessionQuery, staleTime: 0 });
        } catch {
          return false;
        }
        continue;
      }
      if (!isCurrentPrincipal(principalId)) return false;
      const grants = qc.getQueryState(membershipsQuery.queryKey);
      if (grants?.status === 'error') return false;
      if (!grantsFresh()) {
        try {
          await qc.fetchQuery({ ...membershipsQuery, staleTime: 0 });
        } catch {
          return false;
        }
        continue;
      }
      return true;
    }
  };
  return useMutation({
    mutationFn: ({ payload, principalId }: CreatePassIntent) => {
      if (!isCurrentPrincipal(principalId))
        throw new Error('The signed-in account changed. Review the pass before creating.');
      const grants = qc.getQueryData<{ items: OrgMembership[] }>(membershipsQuery.queryKey);
      const canIssue =
        grantsFresh() &&
        grants?.items.some(
          (membership) =>
            membership.userId === principalId &&
            membership.orgId === payload.orgId &&
            membership.revokedAt === null &&
            membership.capabilities.includes('passes:operate') &&
            membership.capabilities.includes('templates:read'),
        );
      if (!canIssue || getMode() !== payload.mode)
        throw new Error(
          'The organization, permissions, or mode changed. Review the pass before creating.',
        );
      if (
        !payload.orgId ||
        !payload.templateId ||
        !payload.templateVersion.trim() ||
        !payload.releaseId ||
        !Number.isSafeInteger(payload.releaseGeneration) ||
        payload.releaseGeneration < 1
      ) {
        throw new Error('Review the current approved release before creating.');
      }
      const fp = fingerprint({ principalId, payload });
      if (keyRef.current.fp !== fp) keyRef.current = { fp, key: newKey() };
      return api.post('/api/v1/passes', PassDetailSchema, payload, {
        headers: { 'idempotency-key': keyRef.current.key },
      });
    },
    onError: async (error, { payload, principalId }) => {
      if (isApiError(error) && error.isConflict && (await confirmReady(principalId)))
        onConflict(payload, principalId);
    },
    onSuccess: async (pass, { payload, firstOfOrg, principalId }) => {
      if (!(await confirmReady(principalId))) return;
      await qc.invalidateQueries({ queryKey: passKeys.all });
      if (!(await confirmReady(principalId))) return;
      const grants = qc.getQueryData<{ items: OrgMembership[] }>(membershipsQuery.queryKey);
      const canRead =
        grantsFresh() &&
        grants?.items.some(
          (membership) =>
            membership.userId === principalId &&
            membership.orgId === payload.orgId &&
            membership.revokedAt === null &&
            membership.capabilities.includes('passes:read'),
        );
      if (getMode() === payload.mode && canRead) qc.setQueryData(passKeys.detail(pass.id), pass);
      markMinted(pass.id);
      markCreated(`pass:${pass.id}`, { sent: payload.sendEmail, first: firstOfOrg });
      onCreated(pass.id, payload.orgId, principalId);
    },
  });
}
