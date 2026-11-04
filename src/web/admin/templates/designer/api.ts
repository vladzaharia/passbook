import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import {
  type SaveVersionResponse,
  SaveVersionResponseSchema,
  TemplateVersionDetailSchema,
} from '@/shared/contracts/index.ts';
import { api } from '../../../lib/api.ts';
import { useDebounced } from '../../../lib/debounce.ts';
import { templateKeys } from '../api.ts';
import { assetsPayload } from './images.ts';
import type { DesignDoc, DraftAsset } from './model.ts';
import { signature } from './reducer.ts';

const body = (doc: DesignDoc, extra: { dryRun: boolean; activate?: boolean }) => ({
  passJson: doc.passJson,
  manifest: doc.manifest,
  assets: assetsPayload(doc.assets),
  ...extra,
});

/** The version the designer starts from: both documents and the file list. */
export function useBaseVersion(templateId: string, version: string | null) {
  return useQuery({
    queryKey: [...templateKeys.detail(templateId), 'design', version],
    queryFn: ({ signal }) =>
      api.get(`/api/v1/templates/${templateId}/versions/${version}`, TemplateVersionDetailSchema, {
        signal,
      }),
    enabled: Boolean(version),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
  });
}

/** Live check: the report, the built pass and the file list, once typing pauses. */
export function useDesignCheck(templateId: string, doc: DesignDoc, enabled = true) {
  const settled = useDebounced(doc, 450);
  const sig = useMemo(() => signature(settled), [settled]);
  const query = useQuery({
    queryKey: ['admin', 'templates', 'design-check', templateId, sig],
    queryFn: ({ signal }) =>
      api.post(
        `/api/v1/templates/${templateId}/versions`,
        SaveVersionResponseSchema,
        body(settled, { dryRun: true }),
        { signal },
      ),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: false,
  });
  return { ...query, checking: settled !== doc || query.isFetching };
}

export function useSaveVersion(templateId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ doc, activate }: { doc: DesignDoc; activate: boolean }) =>
      api.post(
        `/api/v1/templates/${templateId}/versions`,
        SaveVersionResponseSchema,
        body(doc, { dryRun: false, activate }),
      ),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: templateKeys.all }),
        qc.invalidateQueries({ queryKey: ['palette'] }),
      ]),
  });
}

export type { SaveVersionResponse };

/** Server file list (with hashes) back into the designer's assets, keeping uploads that match. */
export function mergeAssets(
  server: SaveVersionResponse['assets'],
  _doc: readonly DraftAsset[],
): DraftAsset[] {
  return server.map((a) => {
    return {
      name: a.name,
      slot: a.slot,
      scale: a.scale,
      size: a.size,
      width: a.width,
      height: a.height,
      sha1: a.sha1,
    };
  });
}
