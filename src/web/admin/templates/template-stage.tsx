import { useMemo, useState } from 'react';
import type { z } from 'zod';
import type { TemplateDetailSchema } from '@/shared/contracts/templates.ts';
import { ChannelStage } from '../../channel-previews/channel-stage.tsx';
import { previewSource } from '../../channel-previews/source.ts';
import { useMintedOnArrival } from '../../lib/motion.ts';
import type { useOrgScope } from '../../lib/org-filter.tsx';
import { Buddy, EmptyState, ErrorState, Skeleton } from '../../ui/index.ts';
import { PassPreview, PassPreviewPanel } from '../passes/pass-preview.tsx';
import { useTemplatePreview } from './api.ts';
import { useTemplateChannels } from './channels/api.ts';
import { PreviewToggle, type PreviewView } from './preview-toggle.tsx';
import { useArrivalDeal } from './use-arrival-deal.ts';

type Template = z.infer<typeof TemplateDetailSchema>;

/** The pass preview beside a template's tabs: the stage for each size, and the still for print. */
export function useTemplateStage(t: Template, scope: ReturnType<typeof useOrgScope>) {
  // Live and a newer draft: the preview toggles between them, the draft first.
  const [view, setView] = useState<PreviewView>('draft');
  const newerDraft = t.release?.draft
    ? t.versions.find((v) => v.version === t.release?.draft?.version)
    : undefined;
  const toggle = Boolean(t.activeVersion && newerDraft);
  const candidate =
    t.activeVersion === null
      ? t.versions.reduce<Template['versions'][number] | undefined>(
          (latest, version) => (!latest || version.createdAt > latest.createdAt ? version : latest),
          undefined,
        )
      : toggle && view === 'draft'
        ? newerDraft
        : undefined;
  const preview = useTemplatePreview(
    t.activeVersion || candidate ? t.id : '',
    scope.orgId,
    candidate?.version,
  );
  // The Channels tab's own data: each preview tab follows it.
  const channels = useTemplateChannels(t.id, scope.orgId ?? '', Boolean(scope.orgId));
  const source = useMemo(
    () => previewSource(preview.data, t, { version: candidate?.version }),
    [preview.data, t, candidate?.version],
  );
  const minted = useMintedOnArrival(`template:${t.id}`);
  const { mint, deal } = useArrivalDeal(minted);

  const panel = (size: 'column' | 'card' | 'sheet') =>
    !t.activeVersion && !candidate ? (
      <EmptyState inline art="template" title="No preview available" />
    ) : preview.data ? (
      <ChannelStage
        size={size}
        source={source}
        title={t.name}
        templateId={t.id}
        orgId={scope.orgId}
        channels={channels.data?.effective}
        channelsTab="channels"
        orgName={scope.membership?.orgName}
        apple={
          <PassPreviewPanel
            passJson={preview.data.passJson}
            assetBaseUrl={preview.data.assetBaseUrl}
            assetNames={preview.data.assetNames}
            enter={size !== 'sheet' && !minted && deal}
            mint={mint}
            label={candidate ? 'Latest draft' : undefined}
            // Arrived from an upload or a duplicate: the buddy waves from the Front / Details row.
            beside={
              minted ? (
                <Buddy size="sm" at="end" mood="happy" scene="wave" className="wl-pass-buddy" />
              ) : undefined
            }
          />
        }
      />
    ) : preview.isError ? (
      <ErrorState inline error={preview.error} onRetry={() => void preview.refetch()} />
    ) : (
      <Skeleton className="mx-auto aspect-[320/420] w-full max-w-xs rounded-xl" />
    );

  const stage = (size: 'column' | 'card' | 'sheet') =>
    toggle ? (
      <PreviewToggle view={view} onView={setView}>
        {panel(size)}
      </PreviewToggle>
    ) : (
      panel(size)
    );
  const still = preview.data ? (
    <PassPreview
      passJson={preview.data.passJson}
      assetBaseUrl={preview.data.assetBaseUrl}
      assetNames={preview.data.assetNames}
      still
    />
  ) : null;
  return { stage, still };
}
