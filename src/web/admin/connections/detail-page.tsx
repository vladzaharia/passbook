import { Link, useNavigate } from '@tanstack/react-router';
import { Pause, Play } from 'lucide-react';
import { useState } from 'react';
import { ACTION_ICON } from '../../lib/action-icons.ts';
import { connectorIcon, ENTITY } from '../../lib/entities.ts';
import { formatCount, formatDateTime } from '../../lib/format.ts';
import { useOrgOptions } from '../../lib/search.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  DropdownMenuItem,
  ErrorState,
  KeyValue,
  MoreMenu,
  PageHeader,
  SkeletonDetail,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  TwoPane,
  TypedConfirmDialog,
  toast,
} from '../../ui/index.ts';
import { confirmWord } from '../../ui/typed-confirm-dialog.tsx';
import { useConnection, useConnectionActions, useConnector, useConnectorNames } from './api.ts';
import { ConfigTab } from './config-tab.tsx';
import { MappingTab, SettingsTab } from './detail-tabs.tsx';
import { HealthPill } from './health.tsx';
import { HealthPanel } from './health-panel.tsx';
import { modeLabel } from './labels.ts';
import type { ConnectionDetailSearch } from './search.ts';
import { type TestOutcome, TestResult } from './test-result.tsx';
import { WebhookPanel } from './webhook.tsx';

export function ConnectionDetailPage({
  connectionId,
  search,
}: {
  connectionId: string;
  search: ConnectionDetailSearch;
}) {
  const navigate = useNavigate();
  const connection = useConnection(connectionId);
  const actions = useConnectionActions(connectionId);
  const orgs = useOrgOptions();
  const [del, setDel] = useState(false);
  const [test, setTest] = useState<TestOutcome>();
  const connector = useConnector(connection.data?.connectorType);
  const connectorName = useConnectorNames();
  const crumbs = [
    { label: 'Connections', to: '/admin/connections' },
    { label: connection.data?.name ?? 'Connection' },
  ];

  if (connection.isError) {
    return (
      <>
        <PageHeader title="Connection" breadcrumbs={crumbs} />
        <ErrorState error={connection.error} onRetry={() => void connection.refetch()} />
      </>
    );
  }
  if (!connection.data) {
    return (
      <>
        <PageHeader title="Connection" breadcrumbs={crumbs} />
        <SkeletonDetail label="Loading connection" />
      </>
    );
  }
  const c = connection.data;
  const caps = connector.data?.capabilities;
  // Until the connector loads, fall back to the mode.
  const showWebhook = caps ? caps.webhook : c.mode === 'webhook' || c.mode === 'hybrid';
  const canSync = caps ? caps.poll || caps.snapshot : c.mode !== 'webhook';
  const tab = search.tab === 'webhook' && !showWebhook ? 'health' : (search.tab ?? 'health');
  const setTab = (next: string) =>
    void navigate({
      to: '.',
      search: { tab: next as NonNullable<ConnectionDetailSearch['tab']> },
      replace: true,
    });
  const Icon = connectorIcon(c.connectorType);
  const orgName = orgs.data?.items.find((o) => o.id === c.orgId)?.name ?? '—';

  async function runTest() {
    try {
      setTest({ kind: 'result', result: await actions.test.mutateAsync(), at: Date.now() });
    } catch (error) {
      setTest({ kind: 'error', error, at: Date.now() });
    }
  }
  const sync = () =>
    actions.sync
      .mutateAsync()
      .then(() => toast.success('Sync started'))
      .catch((error: unknown) => toast.error(error, 'Could not start the sync'));
  const sample = test?.kind === 'result' ? test.result.sample : undefined;

  return (
    <>
      <PageHeader
        title={c.name}
        breadcrumbs={crumbs}
        meta={
          <>
            <HealthPill health={c.enabled ? c.health : 'disabled'} />
            <span className="inline-flex items-center gap-1.5">
              <Icon aria-hidden className="size-4" />
              {connectorName(c.connectorType)} · {modeLabel(c.mode)}
            </span>
            <TestResult outcome={test} className="max-lg:w-full lg:max-w-md" />
          </>
        }
        actions={
          <>
            <Button
              variant="outline"
              busy="pulse"
              loading={actions.test.isPending}
              iconStart={<ACTION_ICON.test aria-hidden />}
              onClick={() => void runTest()}
            >
              Test
            </Button>
            {canSync ? (
              <Button
                variant="outline"
                busy="spin"
                loading={actions.sync.isPending}
                disabled={!c.enabled}
                iconStart={<ACTION_ICON.refresh aria-hidden />}
                onClick={() => void sync()}
              >
                Sync now
              </Button>
            ) : null}
            <MoreMenu>
              <DropdownMenuItem
                onSelect={() =>
                  actions.update
                    .mutateAsync({ enabled: !c.enabled })
                    .then(() =>
                      toast.success(c.enabled ? 'Connection disabled' : 'Connection enabled'),
                    )
                    .catch((error: unknown) =>
                      toast.error(error, c.enabled ? 'Could not disable' : 'Could not enable'),
                    )
                }
              >
                {c.enabled ? <Pause aria-hidden /> : <Play aria-hidden />}
                {c.enabled ? 'Disable' : 'Enable'}
              </DropdownMenuItem>
              <DropdownMenuItem destructive onSelect={() => setDel(true)}>
                <ACTION_ICON.delete aria-hidden />
                Delete
              </DropdownMenuItem>
            </MoreMenu>
          </>
        }
      />
      <TwoPane
        aside={
          <Card>
            <CardHeader title="Overview" />
            <CardBody>
              <KeyValue
                items={[
                  {
                    label: 'Passes',
                    value:
                      c.metrics.passCount === 0 ? (
                        'None'
                      ) : (
                        <Link
                          to="/admin/passes"
                          search={{ connectionId: c.id }}
                          className="inline-flex items-center gap-1.5 rounded-sm font-medium text-accent-fg tabular-nums hover:underline"
                        >
                          <ENTITY.pass.icon aria-hidden className="size-4" />
                          {formatCount(c.metrics.passCount)}{' '}
                          {c.metrics.passCount === 1 ? 'pass' : 'passes'}
                        </Link>
                      ),
                  },
                  { label: 'Organization', value: orgName },
                  { label: 'Creates passes', value: c.autoCreate ? 'On' : 'Off' },
                  { label: 'Created', value: formatDateTime(c.createdAt) },
                ]}
              />
            </CardBody>
          </Card>
        }
      >
        <Tabs value={tab} onValueChange={setTab} className="min-w-0">
          <TabsList aria-label="Connection sections">
            <TabsTrigger value="health">Health</TabsTrigger>
            <TabsTrigger value="mapping">Mapping</TabsTrigger>
            <TabsTrigger value="config">Configuration</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
            {showWebhook ? <TabsTrigger value="webhook">Webhook</TabsTrigger> : null}
          </TabsList>
          <TabsContent value="health">
            <HealthPanel
              connection={c}
              canSync={canSync && c.enabled}
              retrying={actions.sync.isPending}
              onRetry={() => void sync()}
            />
          </TabsContent>
          <TabsContent value="mapping">
            <MappingTab
              key={`${JSON.stringify(c.mapping ?? {})}|${c.defaultTemplateId}`}
              c={c}
              sample={sample}
              loadingSample={actions.test.isPending}
              onLoadSample={() => void runTest()}
            />
          </TabsContent>
          <TabsContent value="config">
            <ConfigTab c={c} />
          </TabsContent>
          <TabsContent value="settings">
            <SettingsTab c={c} />
          </TabsContent>
          {showWebhook ? (
            <TabsContent value="webhook">
              <WebhookPanel
                url={c.webhookUrl}
                hasSecret={c.hasWebhookSecret}
                onRotate={async (webhookSecret) => {
                  await actions.update.mutateAsync({ webhookSecret });
                }}
              />
            </TabsContent>
          ) : null}
        </Tabs>
      </TwoPane>
      <TypedConfirmDialog
        open={del}
        onOpenChange={setDel}
        title={`Delete ${c.name}?`}
        description="Bound passes keep their data and stop syncing."
        word={confirmWord({ title: c.name })}
        confirmLabel="Delete"
        onConfirm={async () => {
          await actions.remove.mutateAsync();
          toast.success('Connection deleted');
          void navigate({ to: '/admin/connections' });
        }}
      />
    </>
  );
}
