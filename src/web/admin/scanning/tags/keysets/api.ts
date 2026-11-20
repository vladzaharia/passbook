import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import {
  type ImportTagsSchema,
  MadeTagKeysetSchema,
  ReenrolledTagKeysetSchema,
  type ReenrolTagKeysetSchema,
  type RotateTagKeysetSchema,
  TagImportResultSchema,
  TagKeysetListSchema,
  TagKeysetViewSchema,
} from '@/shared/contracts/nfc-tag-keysets.ts';
import type { CreateTagKeysetSchema } from '@/shared/contracts/nfc-tags.ts';
import { api } from '@/web/lib/api.ts';
import { useMode } from '@/web/lib/mode.ts';

/** `/api/v1/nfc/keysets`. Keys come back only in the answer that makes them: these writes skip the mutation cache. */
const BASE = '/api/v1/nfc/keysets';
const path = (id: string) => `${BASE}/${encodeURIComponent(id)}`;

export type Keyset = z.infer<typeof TagKeysetViewSchema>;
export type MadeKeyset = z.infer<typeof MadeTagKeysetSchema>;
export type ImportResult = z.infer<typeof TagImportResultSchema>;

export const keysetKeys = {
  all: ['tag-keysets'] as const,
  list: (orgId: string, mode: string) => ['tag-keysets', orgId, mode] as const,
};

export function useKeysets(orgId: string) {
  const mode = useMode();
  return useQuery({
    queryKey: keysetKeys.list(orgId, mode),
    queryFn: ({ signal }) => api.get(BASE, TagKeysetListSchema, { query: { orgId }, signal }),
  });
}

/** Writes on keysets: each refreshes the list. */
export function useKeysetWrites(orgId: string) {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: keysetKeys.all });
  const done = <T>(result: T) => refresh().then(() => result);
  return {
    create: (body: z.infer<typeof CreateTagKeysetSchema>) =>
      api.post(BASE, MadeTagKeysetSchema, body, { query: { orgId } }).then(done),
    rotate: (id: string, body: z.infer<typeof RotateTagKeysetSchema>) =>
      api.post(`${path(id)}/rotate`, MadeTagKeysetSchema, body).then(done),
    retire: (id: string, version: number) =>
      api.post(`${path(id)}/keys/${version}/retire`, TagKeysetViewSchema).then(done),
    revoke: (id: string, version: number) =>
      api.post(`${path(id)}/keys/${version}/revoke`, TagKeysetViewSchema).then(done),
    disable: (id: string) => api.post(`${path(id)}/disable`, TagKeysetViewSchema).then(done),
    reenrol: (id: string, body: z.infer<typeof ReenrolTagKeysetSchema>) =>
      api.post(`${path(id)}/reenrol`, ReenrolledTagKeysetSchema, body).then(done),
    /** A dry run changes nothing, so it leaves the list alone. */
    importTags: (id: string, body: z.infer<typeof ImportTagsSchema>) =>
      api
        .post(`${path(id)}/import`, TagImportResultSchema, body)
        .then((result) => (body.dryRun ? result : done(result))),
  };
}
