import { useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import type { z } from 'zod';
import type { TemplateDetailSchema } from '@/shared/contracts/templates.ts';
import { ChannelStage } from '../../channel-previews/channel-stage.tsx';
import { previewSource } from '../../channel-previews/source.ts';
import { useMode } from '../../lib/mode.ts';
import { useMintedOnArrival } from '../../lib/motion.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { useSession } from '../../lib/session.ts';
import {
  Buddy,
  type Crumb,
  EmptyState,
  ErrorState,
  JsonViewer,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '../../ui/index.ts';
import { useCreated } from '../passes/created.tsx';
import { PassPreview, PassPreviewPanel } from '../passes/pass-preview.tsx';
import { PreviewLayout } from '../passes/preview-layout.tsx';
import { useTemplatePreview } from './api.ts';
import { useTemplateChannels } from './channels/api.ts';
import { TemplateChannelsPanel } from './channels/channels-panel.tsx';
import { TemplateDetailHeader } from './detail-header.tsx';
import { ManifestEditor } from './manifest-editor.tsx';
import { PreviewToggle, type PreviewView } from './preview-toggle.tsx';
import { ReleaseStrip } from './releases/release-strip.tsx';
import { RolloutCard } from './releases/rollout-card.tsx';
import { TemplateReleasesPanel } from './releases/template-releases-panel.tsx';
import { useReleaseControls } from './releases/use-release-controls.tsx';
import type { templateDetailSearchSchema } from './search.ts';
import { DuplicateDialog, OrgDialog } from './template-dialogs.tsx';
import {
  type TemplateCreated,
  TemplateCreatedCallout,
  useTemplateLifecycle,
} from './template-lifecycle.tsx';
import { TemplateInputs, TemplateOverview } from './template-overview.tsx';
import { useScanPasses } from './use-scan-passes.ts';
import { versionName, versionNumber, vOf } from './versions.ts';
import { VersionsPanel } from './versions-panel.tsx';

type Template = z.infer<typeof TemplateDetailSchema>;
type Tab = NonNullable<z.infer<typeof templateDetailSearchSchema>['tab']>;

export function TemplateDetailContent({
  template: t,
  tab,
  crumbs,
}: {
  template: Template;
  tab: Tab;
  crumbs: Crumb[];
}) {
  const navigate = useNavigate();
  const scope = useOrgScope();
  const { isAdmin, authed } = useSession();
  const mode = useMode();
  const canAuthor = scope.membership?.capabilities.includes('templates:author') ?? false;
  const canEdit = canAuthor && (t.orgId !== null || isAdmin);
  const canPublish =
    (scope.membership?.capabilities.includes('templates:publish') ?? false) &&
    (t.orgId !== null || isAdmin);
  const canOperate = scope.membership?.capabilities.includes('passes:operate') ?? false;
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
  const life = useTemplateLifecycle(t, canPublish);
  const state = t.release;
  const draftHash = state?.draft?.version ?? '';
  const draftName = draftHash ? vOf(t, draftHash) : '';
  const controls = useReleaseControls(t.id, scope.orgId, (hash) => vOf(t, hash));
  const alt =
    state?.next === 'try'
      ? 'release'
      : state?.next === 'release' && state.test?.version !== draftHash
        ? 'try'
        : null;
  const scanning = useScanPasses(t);
  const created = useCreated<TemplateCreated>(`template:${t.id}`);
  const importedVersion = useCreated<string>(`template:${t.id}:version`);
  const minted = useMintedOnArrival(`template:${t.id}`);
  // A duplicate mints once on arrival (the value must change after mount); a hard load deals once.
  const [mint, setMint] = useState(0);
  const [deal, setDeal] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setDeal(false), 900);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    if (minted) setMint(1);
  }, [minted]);
  const [duplicate, setDuplicate] = useState(false);
  const [changingOrg, setChangingOrg] = useState(false);
  const canAssign = canAuthor && isAdmin;
  const baked = t.origin === 'baked';
  const archived = t.status === 'archived';
  // Hashes stay in the Versions tab; versions show by number. The live version and the newest
  // inactive one are separate things, and an upload names the version it just made.
  const labelOf = (hash: string | null | undefined) => {
    const n = versionNumber(t, hash ?? null);
    return n ? versionName(n) : null;
  };
  const importedLabel = labelOf(importedVersion.mark);

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

  return (
    <>
      <TemplateDetailHeader
        template={t}
        crumbs={crumbs}
        orgId={scope.orgId}
        canAuthor={canAuthor}
        canEdit={canEdit}
        canPublish={canPublish}
        canOperate={canOperate}
        lifecycleMenu={life.menu}
        onDuplicate={() => setDuplicate(true)}
        onChangeOrg={canAssign ? () => setChangingOrg(true) : undefined}
        onScanPasses={scanning.canScan ? scanning.scan : undefined}
        scanPending={scanning.pending}
        draftName={draftName}
        onTry={() => void controls.tryVersion(draftHash)}
        onRelease={() => controls.release(draftHash)}
        onReview={() => void navigate({ to: '.', search: { tab: 'versions' }, replace: true })}
        tryPending={controls.trying}
      />
      {state && !archived ? (
        <ReleaseStrip
          state={state}
          name={(hash) => vOf(t, hash)}
          alt={alt}
          releaseLabel={state.alone ? 'Release' : 'Request review'}
          onTry={() => void controls.tryVersion(draftHash)}
          onRelease={() => controls.release(draftHash)}
        />
      ) : null}
      {life.notice}
      {canAuthor && created.shown && created.mark ? (
        <div className="mb-6">
          <TemplateCreatedCallout
            template={t}
            how={created.mark}
            versionLabel={importedLabel}
            onDismiss={created.dismiss}
            onScanPasses={scanning.canScan ? scanning.scan : undefined}
            scanPending={scanning.pending}
          />
        </div>
      ) : null}
      <PreviewLayout
        title={t.name}
        stage={stage}
        still={
          preview.data ? (
            <PassPreview
              passJson={preview.data.passJson}
              assetBaseUrl={preview.data.assetBaseUrl}
              assetNames={preview.data.assetNames}
              still
            />
          ) : null
        }
      >
        <Tabs
          value={tab}
          onValueChange={(v) =>
            void navigate({ to: '.', search: { tab: v as Tab }, replace: true })
          }
          className="min-w-0"
        >
          <TabsList aria-label="Template sections">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="versions">Releases</TabsTrigger>
            <TabsTrigger value="channels">Channels</TabsTrigger>
            <TabsTrigger value="manifest">Manifest</TabsTrigger>
            <TabsTrigger value="inputs">Inputs</TabsTrigger>
          </TabsList>
          <TabsContent value="overview">
            <TemplateOverview template={t} canAssign={canAssign} />
          </TabsContent>
          <TabsContent value="versions">
            {scope.orgId && scope.membership ? (
              <TemplateReleasesPanel
                key={`${scope.orgId}:${mode}`}
                templateId={t.id}
                templateOrigin={t.origin}
                templateStatus={t.status}
                templateOrgId={t.orgId}
                orgId={scope.orgId}
                mode={mode}
                versions={t.versions}
                capabilities={scope.membership.capabilities}
                currentUserId={authed?.user.id ?? null}
                release={state}
              />
            ) : null}
            <VersionsPanel
              template={t}
              rollout={<RolloutCard template={t} scope={scope} />}
              draft={draftHash || undefined}
              onTry={
                state?.next && state.next !== 'wait' && !archived
                  ? (v) => void controls.tryVersion(v)
                  : undefined
              }
              onRelease={
                state?.next && state.next !== 'wait' && !archived ? controls.release : undefined
              }
            />
          </TabsContent>
          <TabsContent value="channels">
            {scope.orgId ? (
              <TemplateChannelsPanel
                key={`${scope.orgId}:${mode}`}
                templateId={t.id}
                orgId={scope.orgId}
                canPublish={canPublish && !archived}
              />
            ) : null}
          </TabsContent>
          <TabsContent value="manifest">
            {baked || !canEdit ? (
              <JsonViewer value={t.manifest} label="Manifest" maxHeight="max-h-[32rem]" />
            ) : (
              <ManifestEditor key={t.activeVersion ?? ''} template={t} />
            )}
          </TabsContent>
          <TabsContent value="inputs">
            <TemplateInputs schema={t.inputSchema} />
          </TabsContent>
        </Tabs>
      </PreviewLayout>
      {canAuthor ? (
        <DuplicateDialog
          key={String(duplicate)}
          template={t}
          open={duplicate}
          onOpenChange={setDuplicate}
        />
      ) : null}
      {canAssign ? (
        <OrgDialog
          key={String(changingOrg)}
          template={t}
          open={changingOrg}
          onOpenChange={setChangingOrg}
        />
      ) : null}
      {life.dialogs}
      {controls.dialog}
    </>
  );
}
