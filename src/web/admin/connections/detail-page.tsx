import { useNavigate } from '@tanstack/react-router';
import { Pause, Play } from 'lucide-react';
import { useState } from 'react';
import { ACTION_ICON } from '../../lib/action-icons.ts';
import { deleteConfirm } from '../../lib/confirms.ts';
import { connectorIcon, ENTITY } from '../../lib/entities.ts';
import { formatDateTime } from '../../lib/format.ts';
import { useOrgOptions } from '../../lib/search.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CountLink,
  DropdownMenuItem,
  detailError,
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
import { CreatedCallout, useCreated } from '../passes/created.tsx';
import { useConnection, useConnectionActions, useConnector, useConnectorNames } from './api.ts';
import { ConfigTab } from './config-tab.tsx';
import { MappingTab, SettingsTab } from './detail-tabs.tsx';
import { HealthPill } from './health.tsx';
import { HealthPanel } from './health-panel.tsx';
import { modeLabel } from './labels.ts';
import type { ConnectionDetailSearch } from './search.ts';
import { showLive, TestModeNote } from './test-mode-note.tsx';
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
  const created = useCreated(`connection:${connectionId}`);
  const connector = useConnector(connection.data?.connectorType);
  const connectorName = useConnectorNames();
  const crumbs = [
    { label: 'Connections', to: '/admin/connections' },
    { label: connection.data?.name ?? 'Connection' },
  ];

  if (connection.isError) {
    return detailError(connection, {
      entity: 'connection',
      to: '/admin/connections',
      header: <PageHeader title="Connection" breadcrumbs={crumbs} />,
    });
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
      .catch((error: unknown) => toast.error(error, 'Could not sync'));
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
      {created.shown ? (
        <div className="mb-6">
          <CreatedCallout
            title="Connection created"
            onDismiss={created.dismiss}
            actions={
              <>
                <Button
                  size="sm"
                  busy="pulse"
                  loading={actions.test.isPending}
                  iconStart={<ACTION_ICON.test aria-hidden />}
                  onClick={() => void runTest()}
                >
                  Test
                </Button>
                {canSync && c.enabled ? (
                  <Button
                    size="sm"
                    variant="outline"
                    busy="spin"
                    loading={actions.sync.isPending}
                    iconStart={<ACTION_ICON.refresh aria-hidden />}
                    onClick={() => void sync()}
                  >
                    Sync now
                  </Button>
                ) : null}
                {showWebhook ? (
                  <Button size="sm" variant="ghost" onClick={() => setTab('webhook')}>
                    Webhook
                  </Button>
                ) : null}
              </>
            }
          />
        </div>
      ) : null}
      <TestModeNote className="mb-4" />
      <TwoPane
        aside={
          <Card>
            <CardHeader title="Overview" />
            <CardBody>
              <KeyValue
                items={[
                  {
                    label: 'Passes',
                    value: (
                      <CountLink
                        count={c.metrics.passCount}
                        noun={['pass', 'passes']}
                        icon={ENTITY.pass.icon}
                        to="/admin/passes"
                        search={{ connectionId: c.id }}
                        onClick={showLive}
                      />
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
              pushOnly={!canSync}
              onWebhookTab={showWebhook ? () => setTab('webhook') : undefined}
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
        {...deleteConfirm('connection', c.name)}
        word={confirmWord({ title: c.name })}
        onConfirm={async () => {
          await actions.remove.mutateAsync();
          toast.success('Connection deleted');
          void navigate({ to: '/admin/connections', replace: true });
        }}
      />
    </>
  );
}
