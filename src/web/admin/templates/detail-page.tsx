import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import type { z } from 'zod';
import type { TemplateDetailSchema } from '@/shared/contracts/templates.ts';
import { ACTION_ICON } from '../../lib/action-icons.ts';
import { isApiError } from '../../lib/errors.ts';
import { useMintedOnArrival } from '../../lib/motion.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  DropdownMenuItem,
  DropdownMenuSeparator,
  EmptyState,
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
  toast,
} from '../../ui/index.ts';
import { PassPreview, PassPreviewPanel } from '../passes/pass-preview.tsx';
import { PreviewLayout } from '../passes/preview-layout.tsx';
import { useTemplate, useTemplateActions, useTemplatePreview } from './api.ts';
import { originLabel } from './gallery.tsx';
import { ManifestEditor } from './manifest-editor.tsx';
import type { templateDetailSearchSchema } from './search.ts';
import { DuplicateDialog } from './template-dialogs.tsx';
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
    if (isApiError(template.error) && template.error.isNotFound)
      return (
        <EmptyState
          heading
          art="torn"
          title="Template not found"
          className="mt-6"
          action={
            <Button asChild variant="outline">
              <Link to="/admin/templates">Back to templates</Link>
            </Button>
          }
        />
      );
    return (
      <>
        <PageHeader title="Template" breadcrumbs={crumbs} />
        <ErrorState error={template.error} onRetry={() => void template.refetch()} />
      </>
    );
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
  const actions = useTemplateActions(t.id);
  const minted = useMintedOnArrival(`template:${t.id}`);
  // A duplicate mints once on arrival: the value must change after mount.
  const [mint, setMint] = useState(0);
  useEffect(() => {
    if (minted) setMint(1);
  }, [minted]);
  const [duplicate, setDuplicate] = useState(false);
  const [ask, setAsk] = useState<'archive' | 'delete' | null>(null);
  const baked = t.origin === 'baked';
  const archived = t.status === 'archived';
  const orgId = t.orgId ?? scope;
  const newPass = { ...(orgId ? { orgId } : {}), templateId: t.id };
  const passes = `${t.passCount} ${t.passCount === 1 ? 'pass' : 'passes'}`;

  const stage = (size: 'column' | 'card' | 'sheet') =>
    preview.data ? (
      <PassPreviewPanel
        passJson={preview.data.passJson}
        assetBaseUrl={preview.data.assetBaseUrl}
        assetNames={preview.data.assetNames}
        enter={size !== 'sheet' && !minted}
        mint={mint}
        label={
          t.activeVersion ? (
            <span className="font-mono">{t.activeVersion.slice(0, 8)}</span>
          ) : undefined
        }
      />
    ) : preview.isError ? (
      <ErrorState error={preview.error} onRetry={() => void preview.refetch()} />
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
            <span>{passes}</span>
          </>
        }
        actions={
          <>
            {archived ? null : (
              <Button asChild iconStart={<ACTION_ICON.create aria-hidden />}>
                <Link to="/admin/passes/new" search={newPass as never}>
                  New pass
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
                  <Link to="/admin/templates/upload" search={{ templateId: t.id } as never}>
                    <ACTION_ICON.upload aria-hidden />
                    Upload version
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {archived ? null : (
                  <DropdownMenuItem destructive onSelect={() => setAsk('archive')}>
                    <ACTION_ICON.void aria-hidden />
                    Archive
                  </DropdownMenuItem>
                )}
                {t.passCount === 0 ? (
                  <DropdownMenuItem destructive onSelect={() => setAsk('delete')}>
                    <ACTION_ICON.delete aria-hidden />
                    Delete
                  </DropdownMenuItem>
                ) : null}
              </MoreMenu>
            )}
          </>
        }
      />
      {archived ? (
        <Callout
          tone="warning"
          className="mb-6"
          title="Archived"
          actions={
            <Button
              size="sm"
              variant="outline"
              iconStart={<ACTION_ICON.unvoid aria-hidden />}
              loading={actions.archive.isPending}
              onClick={() =>
                actions.archive
                  .mutateAsync(false)
                  .then(() => toast.success('Template restored'))
                  .catch((error: unknown) => toast.error(error))
              }
            >
              Restore
            </Button>
          }
        >
          New passes cannot use it. Existing passes keep working.
        </Callout>
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
              { label: 'Passes', value: passes },
              { label: 'Version', value: t.activeVersion?.slice(0, 8) ?? null, mono: true },
            ]}
          />
        }
      >
        <Tabs
          value={tab}
          onValueChange={(v) =>
            void navigate({ to: '.', search: { tab: v as Tab } as never, replace: true })
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
      <ConfirmDialog
        open={ask === 'archive'}
        onOpenChange={(o) => !o && setAsk(null)}
        title="Archive template?"
        description={`New passes cannot use it. ${t.passCount} existing ${t.passCount === 1 ? 'pass keeps' : 'passes keep'} working.`}
        confirmLabel="Archive"
        destructive
        onConfirm={async () => {
          await actions.archive.mutateAsync(true);
          toast.success('Template archived');
        }}
      />
      <ConfirmDialog
        open={ask === 'delete'}
        onOpenChange={(o) => !o && setAsk(null)}
        title="Delete template?"
        description="Deletes the template and its versions."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          await actions.remove.mutateAsync();
          toast.success('Template deleted');
          void navigate({ to: '/admin/templates' });
        }}
      />
    </>
  );
}
