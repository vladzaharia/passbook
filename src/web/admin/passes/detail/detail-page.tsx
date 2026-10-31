import { Link, useNavigate } from '@tanstack/react-router';
import type { z } from 'zod';
import { isApiError } from '../../../lib/errors.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  PageHeader,
  Select,
  Skeleton,
  StatusPill,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '../../../ui/index.ts';
import { useTemplate } from '../../templates/api.ts';
import { usePass, usePassVersion } from '../api.ts';
import { PassPreviewPanel } from '../pass-preview.tsx';
import type { passDetailSearchSchema } from '../search.ts';
import { ConnectionTab } from './connection-tab.tsx';
import { DeliveryTab } from './delivery-tab.tsx';
import { FieldsTab } from './fields-tab.tsx';
import { PassHeaderActions } from './header-actions.tsx';
import { HolderTab } from './holder-tab.tsx';
import { ImagesTab } from './images-tab.tsx';
import { ActivityTab, DevicesTab } from './info-tabs.tsx';
import { VersionsTab } from './versions-tab.tsx';

type Search = z.infer<typeof passDetailSearchSchema>;
type Tab = NonNullable<Search['tab']>;

export function PassDetailPage({ passId, search }: { passId: string; search: Search }) {
  const navigate = useNavigate();
  const pass = usePass(passId);
  const template = useTemplate(pass.data?.templateId);
  const picked = search.v !== undefined && search.v !== pass.data?.version ? search.v : undefined;
  const version = usePassVersion(passId, picked);
  const tab: Tab = search.tab ?? 'fields';
  const setSearch = (patch: Partial<Search>) =>
    void navigate({
      to: '.',
      search: ((prev: Search) => {
        const next = { ...prev, ...patch };
        return Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined));
      }) as never,
      replace: true,
    });

  const crumbs = [{ label: 'Passes', to: '/admin/passes' }, { label: pass.data?.serial ?? 'Pass' }];
  if (pass.isError) {
    const missing = isApiError(pass.error) && pass.error.isNotFound;
    return (
      <>
        <PageHeader title="Pass" breadcrumbs={crumbs} />
        {missing ? (
          <EmptyState
            title="Pass not found"
            action={
              <Button asChild>
                <Link to="/admin/passes">Back to passes</Link>
              </Button>
            }
          />
        ) : (
          <ErrorState error={pass.error} onRetry={() => void pass.refetch()} />
        )}
      </>
    );
  }
  if (!pass.data) {
    return (
      <>
        <PageHeader title="Pass" breadcrumbs={crumbs} />
        <Skeleton className="h-64 w-full" />
      </>
    );
  }
  const p = pass.data;
  const shown = picked !== undefined && version.data ? version.data : p;

  return (
    <>
      <PageHeader
        title={p.title ?? p.serial}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <StatusPill status={p.status} />
            <StatusPill status={p.holderState} />
            <span>v{p.version}</span>
          </span>
        }
        breadcrumbs={crumbs}
        actions={<PassHeaderActions pass={p} />}
      />
      {p.warnings.length > 0 ? (
        <ul className="mb-4 list-disc rounded-lg border border-warning-border bg-warning-subtle py-2 pr-3 pl-7 text-sm text-fg-strong">
          {p.warnings.map((w) => (
            <li key={`${w.code}${w.path ?? ''}`}>{w.message}</li>
          ))}
        </ul>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-[20rem_1fr]">
        <Card className="lg:self-start">
          <CardHeader
            title="Preview"
            actions={
              <Select
                aria-label="Version"
                className="w-28"
                value={String(picked ?? p.version)}
                onValueChange={(v) =>
                  setSearch({ v: Number(v) === p.version ? undefined : Number(v) })
                }
                options={[...p.versions]
                  .sort((a, b) => b.version - a.version)
                  .map((v) => ({
                    value: String(v.version),
                    label: `v${v.version}${v.version === p.version ? ' (current)' : ''}`,
                    disabled: v.purged,
                  }))}
              />
            }
          />
          <CardBody>
            {picked !== undefined && version.isError ? (
              <ErrorState error={version.error} title="Could not load version" />
            ) : picked !== undefined && version.isPending ? (
              <Skeleton className="h-80 w-full" />
            ) : (
              <PassPreviewPanel
                passJson={shown.passJson}
                assetBaseUrl={shown.assetBaseUrl}
                assetNames={p.assetNames}
              />
            )}
          </CardBody>
        </Card>
        <Tabs value={tab} onValueChange={(t) => setSearch({ tab: t as Tab })} className="min-w-0">
          <TabsList aria-label="Pass sections">
            {(
              [
                ['fields', 'Fields'],
                ['holder', 'Holder'],
                ['images', 'Images'],
                ['delivery', 'Delivery'],
                ['versions', 'Versions'],
                ['connection', 'Connection'],
                ['devices', 'Devices'],
                ['activity', 'Activity'],
              ] as const
            ).map(([value, label]) => (
              <TabsTrigger key={value} value={value}>
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="fields">
            {template.isError ? (
              <ErrorState error={template.error} onRetry={() => void template.refetch()} />
            ) : template.data ? (
              <FieldsTab
                key={p.id}
                pass={p}
                schema={template.data.inputSchema}
                manifest={template.data.manifest}
              />
            ) : (
              <Skeleton className="h-48 w-full" />
            )}
          </TabsContent>
          <TabsContent value="holder">
            <HolderTab key={p.holderEmail ?? ''} pass={p} />
          </TabsContent>
          <TabsContent value="images">
            <ImagesTab passId={p.id} passJson={p.passJson} />
          </TabsContent>
          <TabsContent value="delivery">
            <DeliveryTab pass={p} />
          </TabsContent>
          <TabsContent value="versions">
            <VersionsTab pass={p} selected={picked} onSelect={(v) => setSearch({ v })} />
          </TabsContent>
          <TabsContent value="connection">
            <ConnectionTab pass={p} />
          </TabsContent>
          <TabsContent value="devices">
            <DevicesTab pass={p} />
          </TabsContent>
          <TabsContent value="activity">
            <ActivityTab passId={p.id} active={tab === 'activity'} />
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}
