import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import type { z } from 'zod';
import type { TemplateDetailSchema } from '@/shared/contracts/templates.ts';
import { useMode } from '../../lib/mode.ts';
import { useMintedOnArrival } from '../../lib/motion.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { useSession } from '../../lib/session.ts';
import {
  Buddy,
  Button,
  Card,
  CardBody,
  CountLink,
  type Crumb,
  EmptyState,
  ErrorState,
  JsonViewer,
  KeyValue,
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
import { TemplateDetailHeader } from './detail-header.tsx';
import { ManifestEditor } from './manifest-editor.tsx';
import { TemplateReleasesPanel } from './releases/template-releases-panel.tsx';
import type { templateDetailSearchSchema } from './search.ts';
import { DuplicateDialog } from './template-dialogs.tsx';
import {
  type TemplateCreated,
  TemplateCreatedCallout,
  useTemplateLifecycle,
} from './template-lifecycle.tsx';
import { TemplateInputs, TemplateOverview } from './template-overview.tsx';
import { versionName, versionNumber } from './versions.ts';
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
  const candidate =
    t.activeVersion === null
      ? t.versions.reduce<Template['versions'][number] | undefined>(
          (latest, version) => (!latest || version.createdAt > latest.createdAt ? version : latest),
          undefined,
        )
      : undefined;
  const preview = useTemplatePreview(
    t.activeVersion || candidate ? t.id : '',
    scope.orgId,
    candidate?.version,
  );
  const life = useTemplateLifecycle(t, canPublish);
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
  const baked = t.origin === 'baked';
  const archived = t.status === 'archived';
  const passCount = (
    <CountLink
      count={t.passCount}
      noun={['pass', 'passes']}
      to="/admin/passes"
      search={{ templateId: t.id, orgId: scope.orgId }}
    />
  );
  // Hashes stay in the Versions tab; versions show by number. The live version and the newest
  // inactive one are separate things, and an upload names the version it just made.
  const labelOf = (hash: string | null | undefined) => {
    const n = versionNumber(t, hash ?? null);
    return n ? versionName(n) : null;
  };
  const activeLabel = labelOf(t.activeVersion);
  const draft = t.versions.reduce<Template['versions'][number] | undefined>(
    (latest, v) => (!v.active && (!latest || v.createdAt > latest.createdAt) ? v : latest),
    undefined,
  );
  const draftLabel = labelOf(draft?.version);
  const importedLabel = labelOf(importedVersion.mark);

  const stage = (size: 'column' | 'card' | 'sheet') =>
    !t.activeVersion && !candidate ? (
      <EmptyState inline art="template" title="No preview available" />
    ) : preview.data ? (
      <PassPreviewPanel
        passJson={preview.data.passJson}
        assetBaseUrl={preview.data.assetBaseUrl}
        assetNames={preview.data.assetNames}
        enter={size !== 'sheet' && !minted && deal}
        mint={mint}
        label={candidate ? 'Latest draft' : (activeLabel ?? undefined)}
        // Arrived from an upload or a duplicate: the buddy waves from the Front / Details row.
        beside={
          minted ? (
            <Buddy size="sm" at="end" mood="happy" scene="wave" className="wl-pass-buddy" />
          ) : undefined
        }
      />
    ) : preview.isError ? (
      <ErrorState inline error={preview.error} onRetry={() => void preview.refetch()} />
    ) : (
      <Skeleton className="mx-auto aspect-[320/420] w-full max-w-xs rounded-xl" />
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
      />
      <Card className="mb-6">
        <CardBody className="grid gap-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-fg-muted">
            Active version
          </p>
          <h2 className="text-xl font-semibold">{activeLabel ?? 'No active version'}</h2>
          {draftLabel ? (
            <p className="text-sm">
              <span className="text-fg-muted">Latest draft: </span>
              {draftLabel}
            </p>
          ) : null}
          <p className="text-sm text-fg-muted">
            {t.orgId ? `Organization: ${t.orgName ?? t.orgId}.` : 'Shared across organizations.'}{' '}
            Template changes are not isolated by the Test view.
          </p>
          <div className="flex flex-wrap gap-2">
            {canEdit && !baked && !archived ? (
              <Button asChild>
                <Link
                  to="/admin/templates/upload"
                  search={{ templateId: t.id, orgId: scope.orgId }}
                >
                  Upload version
                </Link>
              </Button>
            ) : null}
            <Button asChild variant="outline">
              <Link to="." search={{ tab: 'versions', orgId: scope.orgId }}>
                View versions
              </Link>
            </Button>
          </div>
        </CardBody>
      </Card>
      {life.notice}
      {canAuthor && created.shown && created.mark ? (
        <div className="mb-6">
          <TemplateCreatedCallout
            template={t}
            how={created.mark}
            versionLabel={importedLabel}
            onDismiss={created.dismiss}
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
        summary={
          <KeyValue
            items={[
              {
                label: 'Organization',
                value: t.orgId ? (t.orgName ?? t.orgId) : 'All organizations',
              },
              { label: 'Passes', value: passCount },
              { label: 'Active version', value: activeLabel },
              { label: 'Latest draft', value: draftLabel },
            ]}
          />
        }
      >
        <Tabs
          value={tab}
          onValueChange={(v) =>
            void navigate({ to: '.', search: { tab: v as Tab, orgId: scope.orgId }, replace: true })
          }
          className="min-w-0"
        >
          <TabsList aria-label="Template sections">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="versions">Versions</TabsTrigger>
            <TabsTrigger value="manifest">Manifest</TabsTrigger>
            <TabsTrigger value="inputs">Inputs</TabsTrigger>
          </TabsList>
          <TabsContent value="overview">
            <TemplateOverview template={t} canAssign={canAuthor && isAdmin} />
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
              />
            ) : null}
            <VersionsPanel template={t} />
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
      {life.dialogs}
    </>
  );
}
