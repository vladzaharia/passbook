import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';
import { EligibleTemplateListSchema } from '@/shared/contracts/template-releases.ts';
import { TemplateVersionDetailSchema } from '@/shared/contracts/templates.ts';
import { api } from '../../lib/api.ts';
import type { NewPassRelease } from './new-pass-types.ts';

/** Load eligible releases and the immutable manifest for the selected version. */
export function useNewPassRelease({
  principalId,
  orgId,
  canReadTemplates,
  displayOrgId,
  displayCanReadTemplates,
  mode,
  linkTemplate,
  templateId,
  orgName,
}: {
  principalId: string | undefined;
  orgId: string | undefined;
  canReadTemplates: boolean;
  displayOrgId: string | undefined;
  displayCanReadTemplates: boolean;
  mode: 'live' | 'test';
  linkTemplate: string | undefined;
  templateId: string | undefined;
  orgName: string | null | undefined;
}): NewPassRelease {
  const eligible = useInfiniteQuery({
    queryKey: [
      'admin',
      'templates',
      'eligible',
      displayOrgId ?? null,
      mode,
      'apple',
      principalId ?? null,
    ],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) => {
      if (!orgId || !canReadTemplates || !principalId)
        throw new Error('Choose an authorized organization.');
      return api.get('/api/v1/templates/eligible', EligibleTemplateListSchema, {
        query: { orgId, mode, provider: 'apple', cursor: pageParam, limit: 200 },
        signal,
      });
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(orgId && canReadTemplates && principalId),
    staleTime: 0,
  });
  const liveUsable = useMemo(() => {
    if (
      !displayOrgId ||
      !displayCanReadTemplates ||
      eligible.isPlaceholderData ||
      (eligible.isFetching && !eligible.isFetchingNextPage) ||
      (eligible.isError && !eligible.isFetchNextPageError)
    )
      return [];
    return (eligible.data?.pages ?? [])
      .flatMap((page) => page.items)
      .filter(
        (item) =>
          (item.templateOrgId === null || item.templateOrgId === displayOrgId) &&
          item.version.trim() &&
          item.candidateHash.trim(),
      )
      .map((item) => ({
        ...item,
        id: item.templateId,
        orgId: item.templateOrgId,
        orgName: item.templateOrgId === null ? null : (orgName ?? null),
      }));
  }, [
    displayOrgId,
    displayCanReadTemplates,
    orgName,
    eligible.data,
    eligible.isError,
    eligible.isFetchNextPageError,
    eligible.isFetching,
    eligible.isFetchingNextPage,
    eligible.isPlaceholderData,
  ]);
  // Freeze the last confirmed release data for display only; an older in-flight
  // eligibility request must not reveal newly arrived data while grants are stale.
  const displayOnly = !orgId && Boolean(displayOrgId && displayCanReadTemplates);
  const lastEligible = useRef<
    | {
        principalId: string;
        orgId: string;
        mode: 'live' | 'test';
        usable: NewPassRelease['usable'];
      }
    | undefined
  >(undefined);
  useEffect(() => {
    if (
      principalId &&
      orgId &&
      canReadTemplates &&
      eligible.isSuccess &&
      !eligible.isPlaceholderData &&
      (!eligible.isFetching || eligible.isFetchingNextPage)
    ) {
      lastEligible.current = { principalId, orgId, mode, usable: liveUsable };
    }
  }, [
    principalId,
    orgId,
    canReadTemplates,
    mode,
    liveUsable,
    eligible.isSuccess,
    eligible.isPlaceholderData,
    eligible.isFetching,
    eligible.isFetchingNextPage,
  ]);
  const previousEligible = lastEligible.current;
  const usable = displayOnly
    ? previousEligible !== undefined &&
      previousEligible.principalId === principalId &&
      previousEligible.orgId === displayOrgId &&
      previousEligible.mode === mode
      ? previousEligible.usable
      : []
    : liveUsable;
  const selectedTemplate = usable.find((item) => item.id === templateId);
  useEffect(() => {
    if (
      !linkTemplate ||
      templateId !== linkTemplate ||
      !orgId ||
      selectedTemplate ||
      !eligible.hasNextPage ||
      eligible.isFetching ||
      eligible.isError
    )
      return;
    void eligible.fetchNextPage();
  }, [
    linkTemplate,
    templateId,
    orgId,
    selectedTemplate,
    eligible.hasNextPage,
    eligible.isFetching,
    eligible.isError,
    eligible.fetchNextPage,
  ]);
  const release = selectedTemplate;
  const version = release?.version;
  const releasedVersion = useQuery({
    queryKey: [
      'admin',
      'templates',
      'released-version',
      principalId ?? null,
      displayOrgId ?? null,
      mode,
      templateId ?? null,
      version ?? null,
    ],
    queryFn: ({ signal }) => {
      if (!principalId || !orgId || !canReadTemplates || !templateId || !version || !release)
        throw new Error('Choose an active approved release.');
      return api.get(
        `/api/v1/templates/${encodeURIComponent(templateId)}/versions/${encodeURIComponent(version)}`,
        TemplateVersionDetailSchema,
        { query: { orgId }, signal },
      );
    },
    enabled: Boolean(principalId && orgId && canReadTemplates && templateId && version && release),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const manifestValue =
    releasedVersion.data?.version === version ? releasedVersion.data?.manifest : undefined;
  const liveManifest =
    manifestValue && typeof manifestValue === 'object' && !Array.isArray(manifestValue)
      ? (manifestValue as Record<string, unknown>)
      : undefined;
  const schemaValue = liveManifest?.inputs;
  const liveSchema =
    schemaValue &&
    typeof schemaValue === 'object' &&
    !Array.isArray(schemaValue) &&
    (schemaValue as Record<string, unknown>).type === 'object'
      ? schemaValue
      : undefined;
  const lastVersion = useRef<
    | {
        principalId: string;
        orgId: string;
        mode: 'live' | 'test';
        templateId: string;
        version: string;
        manifest: Record<string, unknown> | undefined;
        schema: unknown;
      }
    | undefined
  >(undefined);
  useEffect(() => {
    if (
      principalId &&
      orgId &&
      canReadTemplates &&
      templateId &&
      version &&
      releasedVersion.isSuccess &&
      !releasedVersion.isFetching &&
      releasedVersion.data.version === version
    ) {
      lastVersion.current = {
        principalId,
        orgId,
        mode,
        templateId,
        version,
        manifest: liveManifest,
        schema: liveSchema,
      };
    }
  }, [
    principalId,
    orgId,
    canReadTemplates,
    mode,
    templateId,
    version,
    liveManifest,
    liveSchema,
    releasedVersion.data,
    releasedVersion.isSuccess,
    releasedVersion.isFetching,
  ]);
  const previousVersion = lastVersion.current;
  const cachedVersion =
    displayOnly &&
    previousVersion !== undefined &&
    previousVersion.principalId === principalId &&
    previousVersion.orgId === displayOrgId &&
    previousVersion.mode === mode &&
    previousVersion.templateId === templateId &&
    previousVersion.version === version
      ? previousVersion
      : undefined;
  const manifest = displayOnly ? cachedVersion?.manifest : liveManifest;
  const schema = displayOnly ? cachedVersion?.schema : liveSchema;
  return {
    eligible,
    usable,
    selectedTemplate,
    release,
    version,
    releasedVersion,
    manifest,
    schema,
  };
}
