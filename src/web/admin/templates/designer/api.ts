import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { z } from 'zod';
import {
  type SaveVersionRequest,
  type SaveVersionResponse,
  SaveVersionResponseSchema,
  TemplateVersionDetailSchema,
} from '@/shared/contracts/index.ts';
import { StampsImpactSchema } from '@/shared/contracts/stamps.ts';
import { useDebounced } from '../../../lib/debounce.ts';
import { templateKeys } from '../api.ts';
import { useDesignerHost, useHostKey } from './host.tsx';
import { assetsPayload } from './images.ts';
import { type DesignDoc, type DraftAsset, isRecord } from './model.ts';
import { signature } from './reducer.ts';
import { readStamps } from './stamps.ts';

type VersionOptions = Partial<Pick<SaveVersionRequest, 'dryRun'>>;

/** The live check builds the slider's count, so the header reads what the strip shows. */
function withPreviewCount(doc: DesignDoc, count: number | undefined): DesignDoc['manifest'] {
  const view = readStamps(doc);
  if (!view || count === undefined) return doc.manifest;
  const sample = isRecord(doc.manifest.sample) ? doc.manifest.sample : {};
  return { ...doc.manifest, sample: { ...sample, [view.input]: count } };
}

const body = (doc: DesignDoc, extra: VersionOptions, previewCount?: number) => ({
  passJson: doc.passJson,
  manifest: extra.dryRun ? withPreviewCount(doc, previewCount) : doc.manifest,
  assets: assetsPayload(doc.assets),
  ...extra,
});

/** The version the designer starts from: both documents and the file list. */
export function useBaseVersion(templateId: string, version: string | null) {
  const { orgId, api } = useDesignerHost();
  const hostKey = useHostKey();
  return useQuery({
    queryKey: [...templateKeys.detail(templateId, orgId), 'design', version, ...hostKey],
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

/**
 * Live check: the report, the built pass and the file list, once typing pauses. `asNew` checks a
 * draft of a blueprint as the named template of that organization.
 */
export function useDesignCheck(
  templateId: string,
  doc: DesignDoc,
  enabled = true,
  previewCount?: number,
  asNew?: { orgId: string; name: string },
) {
  const { orgId, api } = useDesignerHost();
  const hostKey = useHostKey();
  const settled = useDebounced(doc, 450);
  const sig = useMemo(() => `${signature(settled)}|${previewCount ?? ''}`, [settled, previewCount]);
  const query = useQuery({
    queryKey: [
      'admin',
      'templates',
      'design-check',
      templateId,
      orgId,
      asNew ?? null,
      sig,
      ...hostKey,
    ],
    queryFn: ({ signal }) =>
      asNew
        ? api.post(
            `/api/v1/templates/${templateId}/use/check`,
            SaveVersionResponseSchema,
            { ...asNew, version: body(settled, {}) },
            { signal },
          )
        : api.post(
            `/api/v1/templates/${templateId}/versions`,
            SaveVersionResponseSchema,
            body(settled, { dryRun: true }, previewCount),
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

/** What a goal change does to the template's live cards. */
export function useStampsImpact(templateId: string, goal: number, enabled: boolean) {
  const { orgId, api } = useDesignerHost();
  const hostKey = useHostKey();
  return useQuery({
    queryKey: ['admin', 'templates', 'stamps-impact', templateId, orgId, goal, ...hostKey],
    queryFn: ({ signal }) =>
      api.get(`/api/v1/templates/${templateId}/stamps-impact`, StampsImpactSchema, {
        query: { goal, orgId },
        signal,
      }),
    enabled: enabled && Boolean(orgId),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

export function useSaveVersion(templateId: string) {
  const { orgId, api } = useDesignerHost();
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

/** A saved version as the designer's documents. */
export function docOf(v: z.infer<typeof TemplateVersionDetailSchema>): DesignDoc {
  return {
    passJson: structuredClone(v.passJson),
    manifest: structuredClone(v.manifest) as Record<string, unknown>,
    assets: mergeAssets(v.assets),
  };
}

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
