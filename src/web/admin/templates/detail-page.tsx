import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import type { z } from 'zod';
import type { TemplateDetailSchema } from '@/shared/contracts/templates.ts';
import { ACTION_ICON } from '../../lib/action-icons.ts';
import { useMintedOnArrival } from '../../lib/motion.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import {
  Badge,
  Buddy,
  Button,
  CountLink,
  DropdownMenuItem,
  DropdownMenuSeparator,
  detailError,
  ErrorState,
  JsonViewer,
  KeyValue,
  MoreMenu,
  PageHeader,
  Skeleton,
  SkeletonDetail,
  StatusPill,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '../../ui/index.ts';
import { useCreated } from '../passes/created.tsx';
import { PassPreview, PassPreviewPanel } from '../passes/pass-preview.tsx';
import { PreviewLayout } from '../passes/preview-layout.tsx';
import { useTemplate, useTemplatePreview } from './api.ts';
import { originLabel } from './gallery.tsx';
import { ManifestEditor } from './manifest-editor.tsx';
import type { templateDetailSearchSchema } from './search.ts';
import { DuplicateDialog } from './template-dialogs.tsx';
import {
  type TemplateCreated,
  TemplateCreatedCallout,
  useTemplateLifecycle,
} from './template-lifecycle.tsx';
import { TemplateInputs, TemplateOverview } from './template-overview.tsx';
import { VersionsPanel } from './versions-panel.tsx';
import '../passes/passes.css';

type Template = z.infer<typeof TemplateDetailSchema>;
type Search = z.infer<typeof templateDetailSearchSchema>;
type Tab = NonNullable<Search['tab']>;

export function TemplateDetailPage({ templateId, search }: { templateId: string; search: Search }) {
  const template = useTemplate(templateId);
  const crumbs = [
    { label: 'Templates', to: '/admin/templates' },
    { label: template.data?.name ?? 'Template' },
  ];
  if (template.isError) {
    return detailError(template, {
      entity: 'template',
      to: '/admin/templates',
      header: <PageHeader title="Template" breadcrumbs={crumbs} />,
    });
  }
  if (!template.data)
    return (
      <>
        <PageHeader title="Template" breadcrumbs={crumbs} />
        <SkeletonDetail label="Loading template" />
      </>
    );
  return <Loaded template={template.data} tab={search.tab ?? 'overview'} crumbs={crumbs} />;
}

function Loaded({
  template: t,
  tab,
  crumbs,
}: {
  template: Template;
  tab: Tab;
  crumbs: { label: string; to?: string }[];
}) {
  const navigate = useNavigate();
  const scope = useOrgScope().orgId;
  const preview = useTemplatePreview(t.id);
  const life = useTemplateLifecycle(t);
  const created = useCreated<TemplateCreated>(`template:${t.id}`);
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
  const orgId = t.orgId ?? scope;
  const newPass = { ...(orgId ? { orgId } : {}), templateId: t.id };
  const passCount = (
    <CountLink
      count={t.passCount}
      noun={['pass', 'passes']}
      to="/admin/passes"
      search={{ templateId: t.id }}
    />
  );
  // Hashes stay in the Versions tab; elsewhere the active version is its number.
  const byAge = [...t.versions].sort((a, b) => a.createdAt - b.createdAt);
  const activeAt = byAge.findIndex((v) => v.version === t.activeVersion);
  const versionLabel = activeAt >= 0 ? `Version ${activeAt + 1}` : null;

  const stage = (size: 'column' | 'card' | 'sheet') =>
    preview.data ? (
      <PassPreviewPanel
        passJson={preview.data.passJson}
        assetBaseUrl={preview.data.assetBaseUrl}
        assetNames={preview.data.assetNames}
        enter={size !== 'sheet' && !minted && deal}
        mint={mint}
        label={versionLabel ?? undefined}
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
      <PageHeader
        title={t.name}
        breadcrumbs={crumbs}
        description={t.description ?? undefined}
        meta={
          <>
            <Badge>{originLabel(t.origin)}</Badge>
            {archived ? <StatusPill status="archived" /> : null}
            <span>
              {t.passCount} {t.passCount === 1 ? 'pass' : 'passes'}
            </span>
          </>
        }
        actions={
          <>
            {archived ? null : (
              <Button asChild iconStart={<ACTION_ICON.create aria-hidden />}>
                <Link to="/admin/passes/new" search={newPass}>
                  New pass
                </Link>
              </Button>
            )}
            {archived ? null : (
              <Button asChild variant="outline" iconStart={<ACTION_ICON.design aria-hidden />}>
                <Link to="/admin/templates/$templateId/design" params={{ templateId: t.id }}>
                  Design
                </Link>
              </Button>
            )}
            <Button
              variant="outline"
              iconStart={<ACTION_ICON.duplicate aria-hidden />}
              onClick={() => setDuplicate(true)}
            >
              Duplicate
            </Button>
            {baked ? null : (
              <MoreMenu>
                <DropdownMenuItem asChild>
                  <Link to="/admin/templates/upload" search={{ templateId: t.id }}>
                    <ACTION_ICON.upload aria-hidden />
                    Upload version
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {life.menu}
              </MoreMenu>
            )}
          </>
        }
      />
      {life.notice}
      {created.shown && created.mark ? (
        <div className="mb-6">
          <TemplateCreatedCallout
            template={t}
            how={created.mark}
            versionLabel={versionLabel}
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
              { label: 'Organization', value: t.orgName ?? 'All organizations' },
              { label: 'Passes', value: passCount },
              { label: 'Version', value: versionLabel },
            ]}
          />
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
            <TabsTrigger value="versions">Versions</TabsTrigger>
            <TabsTrigger value="manifest">Manifest</TabsTrigger>
            <TabsTrigger value="inputs">Inputs</TabsTrigger>
          </TabsList>
          <TabsContent value="overview">
            <TemplateOverview template={t} />
          </TabsContent>
          <TabsContent value="versions">
            <VersionsPanel template={t} />
          </TabsContent>
          <TabsContent value="manifest">
            {baked ? (
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
      <DuplicateDialog
        key={String(duplicate)}
        template={t}
        open={duplicate}
        onOpenChange={setDuplicate}
      />
      {life.dialogs}
    </>
  );
}
