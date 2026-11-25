import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import type { z } from 'zod';
import type { TemplateDetailSchema } from '@/shared/contracts/templates.ts';
import { TEMPLATE_BRAND_COPY } from '@/shared/copy/template-brand.ts';
import { useMode } from '../../lib/mode.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { useSession } from '../../lib/session.ts';
import {
  type Crumb,
  JsonViewer,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '../../ui/index.ts';
import { useCreated } from '../passes/created.tsx';
import { PreviewLayout } from '../passes/preview-layout.tsx';
import { TemplateChannelsPanel } from './channels/channels-panel.tsx';
import { useChannelDraft } from './channels/use-channel-draft.ts';
import { TemplateDetailHeader } from './detail-header.tsx';
import { ManifestEditor } from './manifest-editor.tsx';
import { stripAlt } from './releases/next-action.ts';
import { ReleaseStrip } from './releases/release-strip.tsx';
import { RolloutBanner } from './releases/rollout-banner.tsx';
import { RolloutCard } from './releases/rollout-card.tsx';
import { TemplateReleasesPanel } from './releases/template-releases-panel.tsx';
import { useReleaseControls } from './releases/use-release-controls.tsx';
import { useTryOnArrival } from './releases/use-try-on-arrival.ts';
import type { VersionReleases } from './releases/version-info.ts';
import type { templateDetailSearchSchema } from './search.ts';
import { DuplicateDialog, OrgDialog } from './template-dialogs.tsx';
import {
  type TemplateCreated,
  TemplateCreatedCallout,
  useTemplateLifecycle,
} from './template-lifecycle.tsx';
import { TemplateInputs, TemplateOverview } from './template-overview.tsx';
import { useTemplateStage } from './template-stage.tsx';
import { useScanPasses } from './use-scan-passes.ts';
import { versionName, versionNumber, vOf } from './versions.ts';
import { VersionsPanel } from './versions-panel.tsx';

type Template = z.infer<typeof TemplateDetailSchema>;
type Tab = NonNullable<z.infer<typeof templateDetailSearchSchema>['tab']>;

export function TemplateDetailContent({
  template: t,
  tab,
  review,
  tryNow,
  crumbs,
}: {
  template: Template;
  tab: Tab;
  review?: string | undefined; // The version under review: its dialog is open.
  tryNow?: boolean | undefined;
  crumbs: Crumb[];
}) {
  const navigate = useNavigate();
  const scope = useOrgScope();
  const { isAdmin } = useSession();
  const mode = useMode();
  const canAuthor = scope.membership?.capabilities.includes('templates:author') ?? false;
  const canEdit = canAuthor && (t.orgId !== null || isAdmin);
  const canPublish =
    (scope.membership?.capabilities.includes('templates:publish') ?? false) &&
    (t.orgId !== null || isAdmin);
  const canOperate = scope.membership?.capabilities.includes('passes:operate') ?? false;
  const { stage, still } = useTemplateStage(t, scope);
  const channelDraft = useChannelDraft(`${scope.orgId}:${mode}:${t.id}`);
  const life = useTemplateLifecycle(t, canPublish);
  const state = t.release;
  const draftHash = state?.draft?.version ?? '';
  const controls = useReleaseControls(t.id, scope.orgId, (hash) => vOf(t, hash), {
    canPublish,
    requestedBy: state?.review.state === 'open' ? state.review.by : null,
    open: review && t.versions.some((v) => v.version === review) ? review : undefined,
    onClose: () => void navigate({ to: '.', search: {}, replace: true }),
  });
  const alt = state ? stripAlt(state) : null;
  useTryOnArrival(tryNow === true, state?.next === 'try' ? draftHash : '', controls.tryVersion);
  const scanning = useScanPasses(t);
  const created = useCreated<TemplateCreated>(`template:${t.id}`);
  const importedVersion = useCreated<string>(`template:${t.id}:version`);
  const [duplicate, setDuplicate] = useState(false);
  const [changingOrg, setChangingOrg] = useState(false);
  const canAssign = canAuthor && isAdmin;
  const archived = t.status === 'archived';
  // Hashes stay in the Versions tab; versions show by number. The live version and the newest
  // inactive one are separate things, and an upload names the version it just made.
  const labelOf = (hash: string | null | undefined) => {
    const n = versionNumber(t, hash ?? null);
    return n ? versionName(n) : null;
  };
  const importedLabel = labelOf(importedVersion.mark);
  const canRelease = Boolean(state?.next && state.next !== 'wait' && !archived);
  const canReview = scope.membership?.capabilities.includes('templates:review') ?? false;
  // The release dry run: the same reach as Release, for a publisher or reviewer, never a built-in.
  const canCompare = canRelease && t.origin !== 'baked' && (canPublish || canReview);
  const versionsPanel = (releases: VersionReleases | null) => (
    <VersionsPanel
      template={t}
      releases={releases}
      rollout={<RolloutCard template={t} scope={scope} />}
      draft={draftHash || undefined}
      onTry={canRelease ? (v) => void controls.tryVersion(v) : undefined}
      onRelease={canRelease ? controls.release : undefined}
      canCompare={canCompare}
    />
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
        draftName={draftHash ? vOf(t, draftHash) : ''}
        onTry={() => void controls.tryVersion(draftHash)}
        onRelease={() => controls.release(draftHash)}
        onReview={() => void navigate({ to: '.', search: { review: draftHash } })}
      />
      <RolloutBanner template={t} scope={scope} />
      {state && !archived ? (
        <ReleaseStrip
          state={state}
          name={(hash) => vOf(t, hash)}
          alt={alt}
          releaseLabel={
            state.alone || state.review.state === 'approved' ? 'Release' : 'Request review'
          }
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
      <PreviewLayout title={t.name} stage={stage} still={still}>
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
            <TabsTrigger value="channels">{TEMPLATE_BRAND_COPY.tab}</TabsTrigger>
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
                release={state}
              >
                {versionsPanel}
              </TemplateReleasesPanel>
            ) : (
              versionsPanel(null)
            )}
          </TabsContent>
          <TabsContent value="channels">
            {scope.orgId ? (
              <TemplateChannelsPanel
                key={`${scope.orgId}:${mode}`}
                templateId={t.id}
                orgId={scope.orgId}
                canPublish={canPublish && !archived}
                canEdit={canEdit && !archived}
                draft={channelDraft}
              />
            ) : null}
          </TabsContent>
          <TabsContent value="manifest">
            {t.origin === 'baked' || !canEdit ? (
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
