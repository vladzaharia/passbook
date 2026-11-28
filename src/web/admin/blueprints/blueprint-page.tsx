import { Link, Navigate, useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import type { z } from 'zod';
import type { TemplateDetailSchema } from '@/shared/contracts/templates.ts';
import { ChannelStage } from '../../channel-previews/channel-stage.tsx';
import { previewSource } from '../../channel-previews/source.ts';
import { ACTION_ICON } from '../../lib/action-icons.ts';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  detailError,
  EmptyState,
  ErrorState,
  KeyValue,
  PageHeader,
  Skeleton,
  SkeletonDetail,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '../../ui/index.ts';
import { PassPreview, PassPreviewPanel } from '../passes/pass-preview.tsx';
import { PreviewLayout } from '../passes/preview-layout.tsx';
import { describeSchema, flatFields } from '../passes/schema-form/index.ts';
import { styleList } from '../templates/labels.ts';
import { TemplateInputs } from '../templates/template-overview.tsx';
import { useBlueprint, useBlueprintPreview } from './api.ts';
import { BlueprintAvatar, BlueprintStage } from './identity.tsx';
import { StaffView } from './staff-view.tsx';
import { UseBlueprintDialog } from './use-dialog.tsx';
import '../passes/passes.css';

type Blueprint = z.infer<typeof TemplateDetailSchema>;
export type BlueprintTab = 'overview' | 'inputs';

const crumbs = (name?: string) => [
  { label: 'Blueprints', to: '/admin/blueprints' },
  { label: name ?? 'Blueprint' },
];

export function BlueprintDetailPage({
  blueprintId,
  tab,
}: {
  blueprintId: string;
  tab?: BlueprintTab | undefined;
}) {
  const query = useBlueprint(blueprintId);
  if (query.isError) {
    return detailError(query, {
      entity: 'blueprint',
      to: '/admin/blueprints',
      header: <PageHeader title="Blueprint" breadcrumbs={crumbs()} />,
    });
  }
  if (!query.data) {
    return (
      <>
        <PageHeader title="Blueprint" breadcrumbs={crumbs()} />
        <SkeletonDetail label="Loading blueprint" />
      </>
    );
  }
  // A template reached by a blueprint link belongs on its own page.
  if (!query.data.blueprint)
    return (
      <Navigate
        from="/admin/o/$orgId"
        to="/admin/o/$orgId/templates/$templateId"
        params={{ templateId: blueprintId }}
        replace
      />
    );
  return <Loaded blueprint={query.data} tab={tab ?? 'overview'} />;
}

/** Passes made before blueprints existed keep updating; new ones come from templates. */
function LegacyPasses({ blueprint: b }: { blueprint: Blueprint }) {
  if (b.passCount === 0) return null;
  const many = b.passCount !== 1;
  return (
    <Callout
      tone="info"
      title={`${b.passCount} ${many ? 'passes' : 'pass'} from before blueprints`}
      actions={
        <Button size="sm" variant="outline" asChild>
          <Link to="/admin/passes" search={{ templateId: b.id }}>
            {many ? 'View passes' : 'View pass'}
          </Link>
        </Button>
      }
    >
      {many ? 'They keep' : 'It keeps'} updating. New passes come from templates.
    </Callout>
  );
}

function Loaded({ blueprint: b, tab }: { blueprint: Blueprint; tab: BlueprintTab }) {
  const navigate = useNavigate();
  const [using, setUsing] = useState(false);
  const preview = useBlueprintPreview(b.id);
  const inputs = flatFields(describeSchema(b.inputSchema));
  const required = inputs.filter((f) => f.required).map((f) => f.label);
  const passJson = preview.data?.passJson;
  const source = useMemo(() => previewSource(preview.data, b), [preview.data, b]);
  const stage = (size: 'column' | 'card' | 'sheet') =>
    preview.data ? (
      <ChannelStage
        size={size}
        source={source}
        title={b.name}
        templateId={b.id}
        apple={
          <BlueprintStage passJson={passJson}>
            <PassPreviewPanel
              passJson={preview.data.passJson}
              assetBaseUrl={preview.data.assetBaseUrl}
              assetNames={preview.data.assetNames}
              enter={size !== 'sheet'}
            />
          </BlueprintStage>
        }
      />
    ) : preview.isError ? (
      <ErrorState inline error={preview.error} onRetry={() => void preview.refetch()} />
    ) : b.activeVersion ? (
      <Skeleton className="mx-auto aspect-[320/420] w-full max-w-xs rounded-xl" />
    ) : (
      <EmptyState inline art="template" title="No preview available" />
    );
  return (
    <>
      <PageHeader
        title={b.name}
        breadcrumbs={crumbs(b.name)}
        avatar={<BlueprintAvatar icon={b.icon} passJson={passJson} />}
        meta={
          <>
            <Badge tone="accent">Blueprint</Badge>
            <span>{styleList(b.styles)}</span>
          </>
        }
        actions={
          <Button iconStart={<ACTION_ICON.create aria-hidden />} onClick={() => setUsing(true)}>
            Use blueprint
          </Button>
        }
      />
      <PreviewLayout
        title={b.name}
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
            void navigate({ to: '.', search: { tab: v as BlueprintTab }, replace: true })
          }
          className="min-w-0"
        >
          <TabsList aria-label="Blueprint sections">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="inputs">Inputs</TabsTrigger>
          </TabsList>
          <TabsContent value="overview">
            <div className="grid gap-6">
              <LegacyPasses blueprint={b} />
              <StaffView blueprintId={b.id} version={b.activeVersion} />
              <Card>
                <CardBody>
                  <KeyValue items={[{ label: 'Required', value: required.join(', ') || 'None' }]} />
                </CardBody>
              </Card>
            </div>
          </TabsContent>
          <TabsContent value="inputs">
            <TemplateInputs schema={b.inputSchema} />
          </TabsContent>
        </Tabs>
      </PreviewLayout>
      <UseBlueprintDialog key={String(using)} blueprint={b} open={using} onOpenChange={setUsing} />
    </>
  );
}
