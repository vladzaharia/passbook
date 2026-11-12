import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import {
  type SaveVersionRequest,
  type SaveVersionResponse,
  SaveVersionResponseSchema,
  TemplateVersionDetailSchema,
} from '@/shared/contracts/index.ts';
import { api } from '../../../lib/api.ts';
import { useDebounced } from '../../../lib/debounce.ts';
import { useOrgScope } from '../../../lib/org-filter.tsx';
import { templateKeys } from '../api.ts';
import { assetsPayload } from './images.ts';
import type { DesignDoc, DraftAsset } from './model.ts';
import { signature } from './reducer.ts';

type VersionOptions = Pick<SaveVersionRequest, 'dryRun'>;

const body = (doc: DesignDoc, extra: VersionOptions) => ({
  passJson: doc.passJson,
  manifest: doc.manifest,
  assets: assetsPayload(doc.assets),
  ...extra,
});

/** The version the designer starts from: both documents and the file list. */
export function useBaseVersion(templateId: string, version: string | null) {
  const { orgId } = useOrgScope();
  return useQuery({
    queryKey: [...templateKeys.detail(templateId, orgId), 'design', version],
    queryFn: ({ signal }) =>
      api.get(`/api/v1/templates/${templateId}/versions/${version}`, TemplateVersionDetailSchema, {
        query: { orgId },
        signal,
      }),
    enabled: Boolean(version && orgId),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
  });
}

/** Live check: the report, the built pass and the file list, once typing pauses. */
export function useDesignCheck(templateId: string, doc: DesignDoc, enabled = true) {
  const { orgId } = useOrgScope();
  const settled = useDebounced(doc, 450);
  const sig = useMemo(() => signature(settled), [settled]);
  const query = useQuery({
    queryKey: ['admin', 'templates', 'design-check', templateId, orgId, sig],
    queryFn: ({ signal }) =>
      api.post(
        `/api/v1/templates/${templateId}/versions`,
        SaveVersionResponseSchema,
        body(settled, { dryRun: true }),
        { signal, query: { orgId } },
      ),
    enabled: enabled && Boolean(orgId),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: false,
  });
  // A blocking issue builds no pass: keep the last card that built, and let the Issues list say why.
  const built = query.data?.passJson ?? undefined;
  const [lastBuilt, setLastBuilt] = useState(built);
  if (built && built !== lastBuilt) setLastBuilt(built);
  return { ...query, lastBuilt, checking: settled !== doc || query.isFetching };
}

export function useSaveVersion(templateId: string) {
  const { orgId } = useOrgScope();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (doc: DesignDoc) =>
      api.post(
        `/api/v1/templates/${templateId}/versions`,
        SaveVersionResponseSchema,
        body(doc, { dryRun: false }),
        { query: { orgId } },
      ),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: templateKeys.all }),
        qc.invalidateQueries({ queryKey: ['palette'] }),
      ]),
  });
}

export type { SaveVersionResponse };

/** The server's file list (with hashes) as the designer's assets; none of them carries bytes. */
export function mergeAssets(server: SaveVersionResponse['assets']): DraftAsset[] {
  return server.map((a) => ({
    name: a.name,
    slot: a.slot,
    scale: a.scale,
    size: a.size,
    width: a.width,
    height: a.height,
    sha1: a.sha1,
  }));
}
