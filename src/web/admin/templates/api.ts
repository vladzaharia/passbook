import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ImportStatusSchema,
  PreviewResponseSchema,
  TemplateDetailSchema,
  TemplateListSchema,
  UploadTemplateResponseSchema,
} from '@/shared/contracts/templates.ts';
import { api } from '../../lib/api.ts';
import { isApiError } from '../../lib/errors.ts';

export interface TemplateFilters {
  orgId?: string | undefined;
  origin?: 'baked' | 'uploaded' | undefined;
  includeArchived?: boolean | undefined;
}

export const templateKeys = {
  all: ['admin', 'templates'] as const,
  list: (f: TemplateFilters) => ['admin', 'templates', 'list', f] as const,
  detail: (id: string) => ['admin', 'templates', 'detail', id] as const,
  import: (id: string) => ['admin', 'templates', 'import', id] as const,
};

export function useTemplates(filters: TemplateFilters, enabled = true) {
  return useQuery({
    queryKey: templateKeys.list(filters),
    queryFn: ({ signal }) =>
      api.get('/api/v1/templates', TemplateListSchema, {
        query: { ...filters, includeArchived: filters.includeArchived || undefined, limit: 200 },
        signal,
      }),
    enabled,
  });
}

export function useTemplate(id: string | undefined) {
  return useQuery({
    queryKey: templateKeys.detail(id ?? ''),
    queryFn: ({ signal }) => api.get(`/api/v1/templates/${id}`, TemplateDetailSchema, { signal }),
    enabled: Boolean(id),
  });
}

export function useTemplatePreview(id: string, version?: string) {
  return useQuery({
    queryKey: ['admin', 'templates', 'preview', id, version ?? null],
    queryFn: ({ signal }) =>
      api.post(`/api/v1/templates/${id}/preview`, PreviewResponseSchema, { version }, { signal }),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useTemplateActions(id: string) {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: templateKeys.all });
  return {
    activate: useMutation({
      mutationFn: (input: { version: string; rebuildPasses: boolean }) =>
        api.post(`/api/v1/templates/${id}/activate`, TemplateDetailSchema, input),
      onSuccess: done,
    }),
    clone: useMutation({
      mutationFn: (input: { orgId: string; name?: string }) =>
        api.post(`/api/v1/templates/${id}/clone`, TemplateDetailSchema, input),
      onSuccess: done,
    }),
    remove: useMutation({
      mutationFn: () => api.delete(`/api/v1/templates/${id}`),
      onSuccess: done,
    }),
  };
}

export function useUploadTemplate() {
  return useMutation({
    mutationFn: ({ file, orgId, name }: { file: File; orgId: string; name?: string }) =>
      api.post(`/api/v1/templates/uploads`, UploadTemplateResponseSchema, file, {
        query: { orgId, name },
        headers: { 'content-type': 'application/zip' },
      }),
  });
}

/** Live preview for a draft input. Debounced by the caller; aborted when the input changes. */
export function useDraftPreview(id: string | undefined, input: Record<string, unknown>) {
  return useQuery({
    queryKey: ['admin', 'templates', 'draft-preview', id, input],
    queryFn: ({ signal }) =>
      api.post(`/api/v1/templates/${id}/preview`, PreviewResponseSchema, { input }, { signal }),
    enabled: Boolean(id),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: false,
  });
}

const POLL_MS = 1500;

/** Polls until the workflow reaches a final state. */
export function useImportStatus(uploadId: string | undefined) {
  return useQuery({
    queryKey: templateKeys.import(uploadId ?? ''),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/templates/uploads/${uploadId}`, ImportStatusSchema, { signal }),
    enabled: Boolean(uploadId),
    staleTime: 0,
    gcTime: 0,
    refetchInterval: (query) => {
      const s = query.state.data?.status;
      if (s === 'complete' || s === 'errored' || s === 'terminated') return false;
      return isApiError(query.state.error) && !query.state.error.isTransient ? false : POLL_MS;
    },
  });
}
