import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  ImportStatusSchema,
  PreviewResponseSchema,
  TemplateDetailSchema,
  TemplateListSchema,
  TemplateReissueResponseSchema,
  UploadListSchema,
  UploadTemplateResponseSchema,
} from '@/shared/contracts/templates.ts';
import { api, listQuery } from '../../lib/api.ts';
import { isApiError } from '../../lib/errors.ts';

export interface TemplateFilters {
  orgId?: string | undefined;
  origin?: 'baked' | 'uploaded' | undefined;
  includeArchived?: boolean | undefined;
  q?: string | undefined;
}

export const templateKeys = {
  all: ['admin', 'templates'] as const,
  list: (f: TemplateFilters) => ['admin', 'templates', 'list', f] as const,
  detail: (id: string) => ['admin', 'templates', 'detail', id] as const,
  import: (id: string) => ['admin', 'templates', 'import', id] as const,
};

export function useTemplates(filters: TemplateFilters, enabled = true) {
  return useQuery(
    listQuery({
      queryKey: templateKeys.list(filters),
      queryFn: ({ signal }) =>
        api.get('/api/v1/templates', TemplateListSchema, {
          query: {
            ...filters,
            includeArchived: filters.includeArchived || undefined,
            q: filters.q || undefined,
            limit: 200,
          },
          signal,
        }),
      enabled,
    }),
  );
}

/** The newest imports for the "Recent uploads" strip. */
export function useRecentUploads(orgId: string | undefined) {
  return useQuery({
    queryKey: ['admin', 'templates', 'uploads', orgId ?? null],
    queryFn: ({ signal }) =>
      api.get('/api/v1/templates/uploads', UploadListSchema, {
        query: { orgId, limit: 5 },
        signal,
      }),
    staleTime: 10_000,
  });
}

export const templateDetailQuery = (id: string) =>
  queryOptions({
    queryKey: templateKeys.detail(id),
    queryFn: ({ signal }) => api.get(`/api/v1/templates/${id}`, TemplateDetailSchema, { signal }),
  });

export function useTemplate(id: string | undefined) {
  return useQuery({ ...templateDetailQuery(id ?? ''), enabled: Boolean(id) });
}

import { fetchPreview } from '../../lib/preview-batch.ts';

export function useTemplatePreview(id: string, version?: string) {
  return useQuery({
    queryKey: ['admin', 'templates', 'preview', id, version ?? null],
    queryFn: ({ signal }) =>
      version
        ? api.post(
            `/api/v1/templates/${id}/preview`,
            PreviewResponseSchema,
            { version },
            { signal },
          )
        : fetchPreview(id),
    staleTime: Number.POSITIVE_INFINITY,
    enabled: Boolean(id),
  });
}

export function useTemplateActions(id: string) {
  const qc = useQueryClient();
  const done = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: templateKeys.all }),
      qc.invalidateQueries({ queryKey: ['palette'] }),
    ]);
  return {
    activate: useMutation({
      mutationFn: (input: { version: string; rebuildPasses: boolean }) =>
        api.post(`/api/v1/templates/${id}/activate`, TemplateDetailSchema, input),
      onSuccess: done,
    }),
    replaceManifest: useMutation({
      mutationFn: (manifest: Record<string, unknown>) =>
        api.put(`/api/v1/templates/${id}/manifest`, TemplateDetailSchema, { manifest }),
      onSuccess: done,
    }),
    assignOrg: useMutation({
      mutationFn: (orgId: string | null) =>
        api.patch(`/api/v1/templates/${id}`, TemplateDetailSchema, { orgId }),
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
    archive: useMutation({
      mutationFn: (archived: boolean) =>
        api.post(
          `/api/v1/templates/${id}/${archived ? 'archive' : 'restore'}`,
          TemplateDetailSchema,
        ),
      onSuccess: done,
    }),
    reissue: useMutation({
      mutationFn: () => api.post(`/api/v1/templates/${id}/reissue`, TemplateReissueResponseSchema),
      onSuccess: async () => {
        await done();
        await qc.invalidateQueries({ queryKey: ['admin', 'passes'] });
      },
    }),
  };
}

export function useUploadTemplate() {
  return useMutation({
    mutationFn: ({ file, orgId, name }: { file: File; orgId?: string; name?: string }) =>
      api.post(`/api/v1/templates/uploads`, UploadTemplateResponseSchema, file, {
        query: { orgId, name },
        headers: { 'content-type': 'application/zip' },
      }),
  });
}

/**
 * Live preview for a draft input, as `orgId`'s pass (its name, colours and logo) when given.
 * Debounced by the caller; aborted when the input changes.
 */
export function useDraftPreview(
  id: string | undefined,
  input: Record<string, unknown>,
  options: { orgId?: string | undefined; version?: string | undefined } = {},
) {
  return useQuery({
    queryKey: ['admin', 'templates', 'draft-preview', id, input, options.orgId, options.version],
    queryFn: ({ signal }) =>
      api.post(
        `/api/v1/templates/${id}/preview`,
        PreviewResponseSchema,
        {
          input,
          ...(options.orgId ? { orgId: options.orgId } : {}),
          ...(options.version ? { version: options.version } : {}),
        },
        { signal },
      ),
    enabled: Boolean(id),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: false,
  });
}

/** Mutable so tests can poll fast. */
export const importPolling = { ms: 1500 };

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
      return isApiError(query.state.error) && !query.state.error.isTransient
        ? false
        : importPolling.ms;
    },
  });
}
