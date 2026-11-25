import {
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type { z } from 'zod';
import {
  type PassImportDto,
  PassImportRowsPageSchema,
  PassImportSchema,
  PassImportUndoResultSchema,
  SavedImportMappingsResultSchema,
} from '@/shared/contracts/pass-imports.ts';
import { IMPORT_COPY as C } from '@/shared/copy/imports.ts';
import { api, buildUrl } from '../../../lib/api.ts';
import { ApiError, problemToError, UserMessageError } from '../../../lib/errors.ts';
import { modeHeaders, useMode } from '../../../lib/mode.ts';
import { importKeys } from './api.ts';
import type { ImportPlan } from './match-model.ts';

const BASE = '/api/v1/pass-imports';
const UNDO_POLL_MS = 2000;
const UNDO_POLLS = 90;

export type UndoResult = z.infer<typeof PassImportUndoResultSchema>;

/** The import was undone: it takes no more checks, commits or discards. */
export const isUndone = (e: unknown): boolean =>
  e instanceof ApiError && e.code === 'IMPORT_UNDONE';

/** When the new passes' emails go out. */
export type EmailSend = false | { send: 'now' } | { send: 'held'; holdMs: number };

export const HOLD_CHOICES = [
  { value: 'now', label: 'Now', holdMs: 0 },
  { value: '5m', label: 'After 5 min', holdMs: 5 * 60_000 },
  { value: '15m', label: 'After 15 min', holdMs: 15 * 60_000 },
  { value: '1h', label: 'After 1 hour', holdMs: 60 * 60_000 },
  { value: '4h', label: 'After 4 hours', holdMs: 4 * 60 * 60_000 },
  { value: '24h', label: 'After 24 hours', holdMs: 24 * 60 * 60_000 },
] as const;

/** Commit once per click: the key makes a repeat of the same click harmless. */
export function useCommitRun(id: string, orgId: string | undefined) {
  const qc = useQueryClient();
  const mode = useMode();
  return useMutation({
    mutationFn: (body: { skipInvalid: boolean; email: EmailSend }) =>
      api.post(`${BASE}/${id}/commit`, PassImportSchema, body, {
        query: { orgId },
        headers: { 'idempotency-key': crypto.randomUUID() },
      }),
    onSuccess: (imp: PassImportDto) => {
      qc.setQueryData(importKeys.detail(imp.id, orgId, mode), imp);
      void qc.invalidateQueries({ queryKey: ['admin', 'pass-imports', 'list'] });
    },
  });
}

/** The checked rows by page; the caller filters by intent (the rows route has no action filter). */
export function useCheckRows(id: string, orgId: string | undefined, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: ['admin', 'pass-imports', 'rows', id, orgId, 'planned'],
    queryFn: ({ signal, pageParam }) =>
      api.get(`${BASE}/${id}/rows`, PassImportRowsPageSchema, {
        query: { orgId, state: 'planned', cursor: pageParam },
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: enabled && Boolean(orgId),
  });
}

/**
 * Undo: removes created passes that were not touched, restores updated ones, cancels held email.
 * The server may answer `running` (a workflow): the same call is repeated until it is done.
 */
export async function undoImport(
  qc: QueryClient,
  id: string,
  orgId: string,
  onTally?: (r: UndoResult) => void,
): Promise<UndoResult> {
  let result: UndoResult;
  try {
    result = await api.post(
      `${BASE}/${id}/undo`,
      PassImportUndoResultSchema,
      {},
      { query: { orgId } },
    );
    if (result.state === 'failed') throw new UserMessageError(C.undo.failed);
    for (let i = 0; result.state === 'running' && i < UNDO_POLLS; i += 1) {
      onTally?.(result);
      await new Promise((r) => setTimeout(r, UNDO_POLL_MS));
      result = await api.post(
        `${BASE}/${id}/undo`,
        PassImportUndoResultSchema,
        {},
        { query: { orgId } },
      );
      if (result.state === 'failed') throw new UserMessageError(C.undo.failed);
    }
  } catch (e) {
    if (e instanceof ApiError && e.code === 'IMPORT_UNDO_RUNNING')
      throw new UserMessageError(C.undo.running);
    throw e;
  }
  await qc.invalidateQueries({ queryKey: importKeys.all });
  await qc.invalidateQueries({ queryKey: ['admin', 'passes'] });
  return result;
}

const savedKey = (templateId: string, orgId: string | undefined) =>
  ['admin', 'pass-imports', 'mappings', templateId, orgId] as const;

/** The template's named mappings, for the picker and "Remember as". */
export function useSavedMappings(templateId: string, orgId: string | undefined) {
  return useQuery({
    queryKey: savedKey(templateId, orgId),
    queryFn: ({ signal }) =>
      api.get(`${BASE}/mappings`, SavedImportMappingsResultSchema, {
        query: { templateId, orgId },
        signal,
      }),
    enabled: Boolean(orgId),
  });
}

export function useSaveMapping(templateId: string, orgId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (m: { name: string; columns: string[]; plan: ImportPlan }) =>
      api.put(
        `${BASE}/mappings`,
        SavedImportMappingsResultSchema,
        { templateId, ...m },
        { query: { orgId } },
      ),
    onSuccess: (r) => qc.setQueryData(savedKey(templateId, orgId), r),
  });
}

/** Saves the template's sample CSV (labels as headers, one valid row), read with the mode header. */
export async function downloadSampleCsv(templateId: string, orgId: string): Promise<void> {
  const res = await fetch(buildUrl(`/api/v1/templates/${templateId}/sample.csv`, { orgId }), {
    headers: { accept: 'text/csv', ...modeHeaders() },
    credentials: 'same-origin',
  });
  if (!res.ok) throw problemToError(res.status, await res.json().catch(() => undefined));
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = 'sample.csv';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
