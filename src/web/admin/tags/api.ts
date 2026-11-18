import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import { TagListSchema, TagSchema } from '@/shared/contracts/nfc-tags.ts';
import { api, listQuery } from '@/web/lib/api.ts';
import { useMode } from '@/web/lib/mode.ts';
import { removeWithTransition } from '@/web/lib/motion.ts';
import { useSettings } from '../settings/queries.ts';

/** Console tag routes (T1), `/api/v1/nfc`. */
const NFC = '/api/v1/nfc';
const tagPath = (id: string) => `${NFC}/tags/${encodeURIComponent(id)}`;

export const tagKeys = {
  all: ['tags'] as const,
  list: (orgId: string, mode: string, state: string, q: string) =>
    ['tags', 'list', orgId, mode, state, q] as const,
  detail: (id: string) => ['tags', 'detail', id] as const,
  pass: (passId: string, mode: string) => ['tags', 'pass', passId, mode] as const,
};

/** The org's tags, newest first, `state` and `q` filtered on the server. */
export function useTagList(orgId: string, state: string | undefined, q: string | undefined) {
  const mode = useMode();
  return useInfiniteQuery(
    listQuery({
      queryKey: tagKeys.list(orgId, mode, state ?? '', q ?? ''),
      initialPageParam: undefined as string | undefined,
      queryFn: ({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) =>
        api.get(`${NFC}/tags`, TagListSchema, {
          query: { orgId, status: state, q, cursor: pageParam, limit: 50 },
          signal,
        }),
      getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor ?? undefined,
    }),
  );
}

export function useTag(id: string | undefined) {
  return useQuery({
    queryKey: tagKeys.detail(id ?? ''),
    enabled: Boolean(id),
    queryFn: ({ signal }) => api.get(tagPath(id ?? ''), TagSchema, { signal }),
  });
}

/** Tags that work with a pass: its own, plus the holder's person-wide ones. */
export function usePassTags(passId: string, enabled = true) {
  const mode = useMode();
  return useQuery({
    queryKey: tagKeys.pass(passId, mode),
    enabled,
    queryFn: ({ signal }) =>
      api.get(`${NFC}/passes/${encodeURIComponent(passId)}/tags`, TagListSchema, { signal }),
  });
}

/** Writes on a tag or its binding. Every one refreshes all tag reads. */
export function useTagMutations() {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: tagKeys.all });
  const post = (action: 'lost' | 'restore') => (id: string) =>
    api.post(`${tagPath(id)}/${action}`, TagSchema);
  return {
    unbind: useMutation({
      mutationFn: (bindingId: string) =>
        api.deleteJson(`${NFC}/bindings/${encodeURIComponent(bindingId)}`, TagSchema),
      // The row shrinks away; the refetch behind it confirms.
      onSuccess: (gone) => {
        removeWithTransition(() =>
          client.setQueriesData<z.infer<typeof TagListSchema>>(
            { queryKey: ['tags', 'pass'] },
            (page) => page && { ...page, items: page.items.filter((t) => t.id !== gone.id) },
          ),
        );
        return refresh();
      },
    }),
    lost: useMutation({ mutationFn: post('lost'), onSuccess: refresh }),
    restore: useMutation({ mutationFn: post('restore'), onSuccess: refresh }),
    rename: useMutation({
      mutationFn: ({ id, label }: { id: string; label: string | null }) =>
        api.patch(tagPath(id), TagSchema, { label }),
      onSuccess: refresh,
    }),
  };
}

/** The org's tag switch. Unknown (loading, no right to read settings) counts as on. */
export function useTagsEnabled(orgId: string): boolean {
  const entry = useSettings(`org:${orgId}`).data?.items.find((i) => i.key === 'nfc.tags');
  const v = entry?.value;
  if (v === undefined) return true;
  return typeof v === 'object' && v !== null && !Array.isArray(v) && v.enabled === true;
}
