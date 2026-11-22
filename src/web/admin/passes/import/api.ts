import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import { OkSchema } from '@/shared/contracts/common.ts';
import {
  type CheckPassImportSchema,
  type CreatePassImportSchema,
  type PassImportDto,
  PassImportEmailRestResultSchema,
  PassImportPageSchema,
  PassImportRowsPageSchema,
  PassImportSchema,
} from '@/shared/contracts/pass-imports.ts';
import { EligibleTemplateListSchema } from '@/shared/contracts/template-releases.ts';
import { api, buildUrl } from '../../../lib/api.ts';
import { problemToError } from '../../../lib/errors.ts';
import { modeHeaders, useMode } from '../../../lib/mode.ts';

const BASE = '/api/v1/pass-imports';
const POLL_MS = 2000;
const RUNNING = new Set<string>(['checking', 'committing']);

export const importKeys = {
  all: ['admin', 'pass-imports'] as const,
  list: (orgId: string | undefined, mode: string) =>
    ['admin', 'pass-imports', 'list', orgId, mode] as const,
  detail: (id: string, orgId: string | undefined, mode: string) =>
    ['admin', 'pass-imports', 'detail', id, orgId, mode] as const,
  templates: (orgId: string | undefined, mode: string) =>
    ['admin', 'pass-imports', 'templates', orgId, mode] as const,
};

/** One import; polled every 2 s while it checks or runs, and only then. */
export function useImport(id: string, orgId: string | undefined) {
  const mode = useMode();
  return useQuery({
    queryKey: importKeys.detail(id, orgId, mode),
    queryFn: ({ signal }) =>
      api.get(`${BASE}/${id}`, PassImportSchema, { query: { orgId }, signal }),
    enabled: Boolean(orgId),
    refetchInterval: (query) =>
      RUNNING.has(query.state.data?.state ?? '') || query.state.data?.undo?.state === 'running'
        ? POLL_MS
        : false,
  });
}

export function useRecentImports(orgId: string | undefined) {
  const mode = useMode();
  return useQuery({
    queryKey: importKeys.list(orgId, mode),
    queryFn: ({ signal }) =>
      api.get(BASE, PassImportPageSchema, { query: { orgId, limit: 10 }, signal }),
    enabled: Boolean(orgId),
  });
}

/** Templates with a release in this mode: the only ones an import can use. */
export function useImportTemplates(orgId: string | undefined) {
  const mode = useMode();
  return useQuery({
    queryKey: importKeys.templates(orgId, mode),
    queryFn: ({ signal }) =>
      api.get('/api/v1/templates/eligible', EligibleTemplateListSchema, {
        query: { orgId, mode, provider: 'apple', limit: 200 },
        signal,
      }),
    enabled: Boolean(orgId),
  });
}

function keep(qc: QueryClient, orgId: string | undefined, mode: string, imp: PassImportDto) {
  qc.setQueryData(importKeys.detail(imp.id, orgId, mode), imp);
  void qc.invalidateQueries({ queryKey: ['admin', 'pass-imports', 'list'] });
}

export function useCreateImport(orgId: string | undefined) {
  const qc = useQueryClient();
  const mode = useMode();
  return useMutation({
    mutationFn: (body: z.input<typeof CreatePassImportSchema>) =>
      api.post(BASE, PassImportSchema, body, { query: { orgId } }),
    onSuccess: (imp) => keep(qc, orgId, mode, imp),
  });
}

export function useCheckImport(id: string, orgId: string | undefined) {
  const qc = useQueryClient();
  const mode = useMode();
  return useMutation({
    mutationFn: (body: z.input<typeof CheckPassImportSchema>) =>
      api.post(`${BASE}/${id}/check`, PassImportSchema, body, { query: { orgId } }),
    onSuccess: (imp) => keep(qc, orgId, mode, imp),
  });
}

export function useDiscardImport(id: string, orgId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.deleteJson(`${BASE}/${id}`, OkSchema, { query: { orgId } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: importKeys.all }),
  });
}

/** Failed rows of a finished import: the first page. */
export function useFailedRows(id: string, orgId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['admin', 'pass-imports', 'rows', id, orgId, 'failed'],
    queryFn: ({ signal }) =>
      api.get(`${BASE}/${id}/rows`, PassImportRowsPageSchema, {
        query: { orgId, state: 'failed' },
        signal,
      }),
    enabled: enabled && Boolean(orgId),
  });
}

/** Emails the passes created without mail, 50 a call on the server's cursor; the server marks each row, so a repeat sends nothing. */
export async function emailTheRest(
  qc: QueryClient,
  id: string,
  orgId: string,
): Promise<{ sent: number; skipped: number }> {
  const total = { sent: 0, skipped: 0 };
  let cursor: string | null = null;
  do {
    const page: z.infer<typeof PassImportEmailRestResultSchema> = await api.post(
      `${BASE}/${id}/email-rest`,
      PassImportEmailRestResultSchema,
      { cursor },
      { query: { orgId } },
    );
    total.sent += page.sent;
    total.skipped += page.skipped;
    cursor = page.nextCursor;
  } while (cursor);
  await qc.invalidateQueries({ queryKey: importKeys.all });
  return total;
}

/** Saves a CSV the server builds (the request carries the mode, which a plain link cannot). */
export async function downloadImportFile(
  id: string,
  orgId: string,
  file: 'errors.csv' | 'results.csv',
): Promise<void> {
  const res = await fetch(buildUrl(`${BASE}/${id}/${file}`, { orgId }), {
    headers: { accept: 'text/csv', ...modeHeaders() },
    credentials: 'same-origin',
  });
  if (!res.ok) throw problemToError(res.status, await res.json().catch(() => undefined));
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = file === 'errors.csv' ? 'rows-with-errors.csv' : 'import-results.csv';
  // In the document while it clicks (Safari), and the object URL outlives the save.
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
