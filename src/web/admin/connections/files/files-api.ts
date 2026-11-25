import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { OkSchema } from '@/shared/contracts/common.ts';
import {
  ApplyConnectionFileResponseSchema,
  ConnectionFileRevisionListSchema,
  ConnectionFileSchema,
  ConnectionFileUploadResultSchema,
} from '@/shared/contracts/connection-files.ts';
import { api } from '../../../lib/api.ts';
import { connectionKeys } from '../api.ts';
import type { UploadBody } from './read-upload.ts';

const base = (id: string) => `/api/v1/connections/${encodeURIComponent(id)}/files`;
const filesKey = (id: string) => [...connectionKeys.detail(id), 'files'] as const;

/** Revisions, newest first. Polls while an applied revision is still syncing. */
export function useRevisions(connectionId: string, enabled = true) {
  return useQuery({
    queryKey: filesKey(connectionId),
    queryFn: ({ signal }) =>
      api.get(base(connectionId), ConnectionFileRevisionListSchema, {
        query: { limit: 20 },
        signal,
      }),
    enabled,
    refetchInterval: (q) => {
      const rows = q.state.data?.items ?? [];
      return rows.some((r) => r.state === 'current' && !r.applied) ? 2000 : false;
    },
  });
}

/** Every write refreshes the revisions and the connection (health, counts). */
function useRefresh(connectionId: string) {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: filesKey(connectionId) }),
      qc.invalidateQueries({ queryKey: connectionKeys.all }),
    ]);
}

export function useUploadRevision(connectionId: string) {
  const refresh = useRefresh(connectionId);
  return useMutation({
    mutationFn: (body: UploadBody) =>
      api.post(base(connectionId), ConnectionFileUploadResultSchema, body),
    onSuccess: refresh,
  });
}

export function useApplyRevision(connectionId: string) {
  const refresh = useRefresh(connectionId);
  return useMutation({
    mutationFn: (fileId: string) =>
      api.post(`${base(connectionId)}/${fileId}/apply`, ApplyConnectionFileResponseSchema),
    onSuccess: refresh,
  });
}

export function useDiscardRevision(connectionId: string) {
  const refresh = useRefresh(connectionId);
  return useMutation({
    mutationFn: (fileId: string) => api.deleteJson(`${base(connectionId)}/${fileId}`, OkSchema),
    onSuccess: refresh,
  });
}

const DRAFTS = '/api/v1/connections/uploads';

/** A parsed upload not yet bound to a connection: the wizard's file. */
export function useDraftUpload(orgId: string | undefined) {
  return useMutation({
    mutationFn: (body: UploadBody) =>
      api.post(DRAFTS, ConnectionFileSchema, body, { query: { orgId } }),
  });
}

/** Reads the stored draft again with another sheet or records array. */
export function useReparseDraft() {
  return useMutation({
    mutationFn: (v: { fileId: string; sheet?: string; recordsPointer?: string }) =>
      api.patch(`${DRAFTS}/${v.fileId}`, ConnectionFileSchema, {
        ...(v.sheet !== undefined ? { sheet: v.sheet } : {}),
        ...(v.recordsPointer !== undefined ? { recordsPointer: v.recordsPointer } : {}),
      }),
  });
}

export function useDiscardDraft() {
  return useMutation({
    mutationFn: (fileId: string) => api.deleteJson(`${DRAFTS}/${fileId}`, OkSchema),
  });
}
