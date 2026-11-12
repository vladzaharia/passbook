import {
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  ImportStatusSchema,
  PreviewResponseSchema,
  TemplateDetailSchema,
  TemplateListSchema,
  UploadListSchema,
  UploadTemplateResponseSchema,
} from '@/shared/contracts/templates.ts';
import { api } from '../../lib/api.ts';
import { isApiError } from '../../lib/errors.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { fetchPreview, scopePreviewAssets, templatePreviewKey } from '../../lib/preview-batch.ts';

export interface TemplateFilters {
  orgId?: string | undefined;
  origin?: 'baked' | 'uploaded' | undefined;
  includeArchived?: boolean | undefined;
  q?: string | undefined;
}

export const templateKeys = {
  all: ['admin', 'templates'] as const,
  list: (f: TemplateFilters) => ['admin', 'templates', 'list', f] as const,
  detail: (id: string, orgId?: string) =>
    ['admin', 'templates', 'detail', id, orgId ?? null] as const,
  import: (id: string, orgId: string | undefined) =>
    ['admin', 'templates', 'import', id, orgId ?? null] as const,
};

function useTemplateListOrg(orgId: string | undefined): string | undefined {
  const scope = useOrgScope();
  return !scope.isLoading &&
    !scope.isError &&
    orgId &&
    orgId === scope.orgId &&
    scope.membership?.capabilities.includes('templates:read')
    ? scope.orgId
    : undefined;
}

/** Pickers and name lookups: the first 200 in one request. The list page pages instead. */
export function useTemplates(filters: TemplateFilters, enabled = true) {
  const orgId = useTemplateListOrg(filters.orgId);
  return useQuery({
    queryKey: templateKeys.list({ ...filters, orgId }),
    queryFn: ({ signal }) => {
      if (!orgId) throw new Error('Choose an authorized organization.');
      return api.get('/api/v1/templates', TemplateListSchema, {
        // The scoped endpoint returns platform templates as well as this organization's templates.
        query: {
          ...filters,
          orgId,
          includeArchived: filters.includeArchived || undefined,
          q: filters.q || undefined,
          limit: 200,
        },
        signal,
      });
    },
    enabled: enabled && Boolean(orgId),
    placeholderData: (previous, query) =>
      orgId && query?.queryKey[3].orgId === orgId ? previous : undefined,
  });
}

/** The Templates list: 50 at a time, newest first; Load more fetches the next page. */
export function useTemplatePages(filters: TemplateFilters) {
  const orgId = useTemplateListOrg(filters.orgId);
  return useInfiniteQuery({
    queryKey: [...templateKeys.all, 'pages', { ...filters, orgId }] as const,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) => {
      if (!orgId) throw new Error('Choose an authorized organization.');
      return api.get('/api/v1/templates', TemplateListSchema, {
        query: {
          ...filters,
          orgId,
          includeArchived: filters.includeArchived || undefined,
          q: filters.q || undefined,
          cursor: pageParam,
          limit: 50,
        },
        signal,
      });
    },
    getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor ?? undefined,
    enabled: Boolean(orgId),
    placeholderData: (previous, query) =>
      orgId && query?.queryKey[3].orgId === orgId ? previous : undefined,
  });
}

/** The newest imports for the "Recent uploads" strip. */
export function useRecentUploads(orgId: string | undefined) {
  const selectedOrgId = useTemplateListOrg(orgId);
  return useQuery({
    queryKey: ['admin', 'templates', 'uploads', selectedOrgId ?? null],
    queryFn: ({ signal }) => {
      if (!selectedOrgId) throw new Error('Choose an authorized organization.');
      return api.get('/api/v1/templates/uploads', UploadListSchema, {
        query: { orgId: selectedOrgId, limit: 5 },
        signal,
      });
    },
    enabled: Boolean(selectedOrgId),
    staleTime: 10_000,
  });
}

/** Bare by-ID reads are server-authorized; shared tenant templates require the selected org. */
export const templateDetailQuery = (id: string, orgId?: string) =>
  queryOptions({
    queryKey: templateKeys.detail(id, orgId),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/templates/${id}`, TemplateDetailSchema, { query: { orgId }, signal }),
  });

export function useTemplate(id: string | undefined, orgId?: string) {
  return useQuery({ ...templateDetailQuery(id ?? '', orgId), enabled: Boolean(id) });
}

/** An undefined org is for an explicitly global preview, not an unselected tenant. */
export function useTemplatePreview(id: string, orgId: string | undefined, version?: string) {
  return useQuery({
    queryKey: templatePreviewKey(id, orgId, version),
    queryFn: async ({ signal }) =>
      version
        ? scopePreviewAssets(
            await api.post(
              `/api/v1/templates/${id}/preview`,
              PreviewResponseSchema,
              { version, ...(orgId ? { orgId } : {}) },
              { query: { orgId }, signal },
            ),
            orgId,
          )
        : fetchPreview(id, orgId),
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
    queryKey: [
      'admin',
      'templates',
      'draft-preview',
      id,
      input,
      options.orgId,
      options.version,
    ] as const,
    queryFn: async ({ signal }) => {
      if (!id) throw new Error('Choose a template.');
      return scopePreviewAssets(
        await api.post(
          `/api/v1/templates/${id}/preview`,
          PreviewResponseSchema,
          {
            input,
            ...(options.orgId ? { orgId: options.orgId } : {}),
            ...(options.version ? { version: options.version } : {}),
          },
          { signal },
        ),
        options.orgId,
      );
    },
    enabled: Boolean(id),
    placeholderData: (previous, query) =>
      id &&
      query?.queryKey[3] === id &&
      query.queryKey[5] === options.orgId &&
      query.queryKey[6] === options.version
        ? previous
        : undefined,
    staleTime: 60_000,
    retry: false,
  });
}

/** Mutable so tests can poll fast. */
export const importPolling = { ms: 1500 };

/** Pass the upload's captured org; undefined is reserved for a platform-global import. */
export function useImportStatus(uploadId: string | undefined, orgId: string | undefined) {
  return useQuery({
    queryKey: templateKeys.import(uploadId ?? '', orgId),
    queryFn: ({ signal }) => {
      if (!uploadId) throw new Error('Choose an upload.');
      return api.get(`/api/v1/templates/uploads/${uploadId}`, ImportStatusSchema, {
        query: { orgId },
        signal,
      });
    },
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
