import { useNavigate } from '@tanstack/react-router';
import { KeyRound, Pause, Play, RefreshCw, Trash2, Zap } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { z } from 'zod';
import type { ConnectionDetailSchema } from '@/shared/contracts/connections.ts';
import { errorMessage } from '../../lib/errors.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  DropdownMenuItem,
  ErrorState,
  FormField,
  Input,
  MoreMenu,
  PageHeader,
  SaveBar,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
} from '../../ui/index.ts';
import { confirmWord, TypedConfirmDialog } from '../../ui/typed-confirm-dialog.tsx';
import { describeSchema, flatFields } from '../passes/schema-form/index.ts';
import { useTemplate } from '../templates/api.ts';
import { useConnection, useConnectionActions, useConnector, useConnectorNames } from './api.ts';
import { ConfigTab } from './config-tab.tsx';
import { HealthPill } from './health.tsx';
import { HealthPanel } from './health-panel.tsx';
import { kindLabel, modeLabel } from './labels.ts';
import {
  type Lifecycle,
  LifecycleFields,
  lifecycleError,
  lifecycleToPatch,
} from './lifecycle-fields.tsx';
import { fromRows, type MappingRow, toRows } from './mapping.ts';
import { MappingEditor } from './mapping-editor.tsx';
import type { ConnectionDetailSearch } from './search.ts';
import { generateSecret, WebhookPanel } from './webhook.tsx';

type Detail = z.infer<typeof ConnectionDetailSchema>;

function lifecycleOf(c: Detail): Lifecycle {
  return {
    mode: c.mode,
    intervalSeconds: c.intervalSeconds === null ? '' : String(c.intervalSeconds),
    holderEmailField: c.holderEmailField ?? '',
    defaultTemplateId: c.defaultTemplateId ?? '',
    autoCreate: c.autoCreate,
    autoEmail: c.autoEmail,
    onMissing: c.onMissing,
  };
}

function MappingTab({ c }: { c: Detail }) {
  const actions = useConnectionActions(c.id);
  const template = useTemplate(c.defaultTemplateId ?? undefined);
  const connector = useConnector(c.connectorType);
  const original = useMemo(() => JSON.stringify(c.mapping ?? {}), [c.mapping]);
  const [rows, setRows] = useState<MappingRow[]>(() => toRows(c.mapping));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const result = fromRows(rows);
  const dirty =
    JSON.stringify(result.mapping) !== original || Object.keys(result.errors).length > 0;
  const guard = useUnsavedChangesGuard(dirty);

  async function save() {
    setErrors(result.errors);
    if (Object.keys(result.errors).length > 0) return;
    try {
      await actions.update.mutateAsync({ mapping: result.mapping });
      toast.success('Mapping saved');
    } catch (error) {
      toast.error(error);
    }
  }

  return (
    <div className="pb-16">
      <MappingEditor
        rows={rows}
        onChange={setRows}
        errors={errors}
        inputKeys={
          template.data
            ? flatFields(describeSchema(template.data.inputSchema)).map((f) => f.key)
            : []
        }
        outputKeys={Object.keys(connector.data?.outputFields ?? {}).map((k) => `/${k}`)}
        disabled={actions.update.isPending}
      />
      <SaveBar
        dirty={dirty}
        saving={actions.update.isPending}
        onSave={() => void save()}
        onDiscard={() => {
          setRows(toRows(c.mapping));
          setErrors({});
        }}
      />
      <UnsavedChangesDialog blocker={guard} />
    </div>
  );
}

function SettingsTab({ c }: { c: Detail }) {
  const actions = useConnectionActions(c.id);
  const connector = useConnector(c.connectorType);
  const initial = useMemo(() => lifecycleOf(c), [c]);
  const [name, setName] = useState(c.name);
  const [life, setLife] = useState<Lifecycle>(initial);
  const [showError, setShowError] = useState(false);
  const dirty = name !== c.name || JSON.stringify(life) !== JSON.stringify(initial);
  const guard = useUnsavedChangesGuard(dirty);
  const error = lifecycleError(life);

  async function save() {
    if (error || !name.trim()) return setShowError(true);
    try {
      await actions.update.mutateAsync({ name: name.trim(), ...lifecycleToPatch(life) });
      setShowError(false);
      toast.success('Settings saved');
    } catch (cause) {
      toast.error(cause);
    }
  }

  return (
    <Card className="max-w-3xl">
      <CardHeader title="Settings" />
      <CardBody className="grid gap-4">
        <FormField
          label="Name"
          required
          error={showError && !name.trim() ? 'Required.' : undefined}
        >
          {(f) => (
            <Input {...f} maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
          )}
        </FormField>
        <LifecycleFields
          orgId={c.orgId}
          capabilities={connector.data?.capabilities}
          value={life}
          onChange={setLife}
          disabled={actions.update.isPending}
          error={showError ? error : undefined}
        />
      </CardBody>
      <SaveBar
        dirty={dirty}
        saving={actions.update.isPending}
        onSave={() => void save()}
        onDiscard={() => {
          setName(c.name);
          setLife(initial);
          setShowError(false);
        }}
      />
      <UnsavedChangesDialog blocker={guard} />
    </Card>
  );
}

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
  const [del, setDel] = useState(false);
  const [rotate, setRotate] = useState(false);
  const [secret, setSecret] = useState<string>();
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string }>();
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
        <Skeleton className="h-64 w-full" />
      </>
    );
  }
  const c = connection.data;
  // Until the connector loads, fall back to the mode.
  const showWebhook = connector.data
    ? connector.data.capabilities.webhook
    : c.mode === 'webhook' || c.mode === 'hybrid';

  const tab = search.tab === 'webhook' && !showWebhook ? 'health' : (search.tab ?? 'health');
  const setTab = (next: string) =>
    void navigate({
      to: '.',
      search: { tab: next as NonNullable<ConnectionDetailSearch['tab']> } as never,
      replace: true,
    });

  async function test() {
    setTestResult(undefined);
    try {
      const r = await actions.test.mutateAsync();
      setTestResult({
        ok: r.ok,
        text: r.ok
          ? `Test passed in ${r.durationMs} ms.${r.detail ? ` ${r.detail}` : ''}`
          : `Test failed${r.errorCode ? ` (${r.errorCode})` : ''}.${r.detail ? ` ${r.detail}` : ''}`,
      });
    } catch (error) {
      setTestResult({ ok: false, text: errorMessage(error) });
    }
  }

  return (
    <>
      <PageHeader
        title={c.name}
        breadcrumbs={crumbs}
        width="detail"
        meta={
          <>
            <HealthPill health={c.enabled ? c.health : 'disabled'} />
            <span>{kindLabel(connectorName(c.connectorType), modeLabel(c.mode))}</span>
          </>
        }
        actions={
          <>
            <Button
              variant="outline"
              iconStart={<Zap aria-hidden />}
              loading={actions.test.isPending}
              onClick={() => void test()}
            >
              Test
            </Button>
            <Button
              variant="outline"
              iconStart={<RefreshCw aria-hidden />}
              loading={actions.sync.isPending}
              disabled={!c.enabled}
              onClick={() =>
                actions.sync
                  .mutateAsync()
                  .then(() => toast.success('Sync started'))
                  .catch((error: unknown) => toast.error(error))
              }
            >
              Sync now
            </Button>
            <MoreMenu>
              <DropdownMenuItem
                onSelect={() =>
                  actions.update
                    .mutateAsync({ enabled: !c.enabled })
                    .then(() =>
                      toast.success(c.enabled ? 'Connection disabled' : 'Connection enabled'),
                    )
                    .catch((error: unknown) => toast.error(error))
                }
              >
                {c.enabled ? <Pause aria-hidden /> : <Play aria-hidden />}
                {c.enabled ? 'Disable' : 'Enable'}
              </DropdownMenuItem>
              {showWebhook ? (
                <DropdownMenuItem onSelect={() => setRotate(true)}>
                  <KeyRound aria-hidden />
                  {c.hasWebhookSecret ? 'Rotate secret' : 'Create secret'}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem destructive onSelect={() => setDel(true)}>
                <Trash2 aria-hidden />
                Delete
              </DropdownMenuItem>
            </MoreMenu>
          </>
        }
      />
      {testResult ? (
        <p
          role={testResult.ok ? 'status' : 'alert'}
          className={`mb-4 max-w-3xl text-sm ${testResult.ok ? 'text-success' : 'text-danger'}`}
        >
          {testResult.text}
        </p>
      ) : null}
      <Tabs value={tab} onValueChange={setTab} className="max-w-3xl min-w-0">
        <TabsList aria-label="Connection sections">
          <TabsTrigger value="health">Health</TabsTrigger>
          <TabsTrigger value="mapping">Mapping</TabsTrigger>
          <TabsTrigger value="config">Configuration</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
          {showWebhook ? <TabsTrigger value="webhook">Webhook</TabsTrigger> : null}
        </TabsList>
        <TabsContent value="health">
          <HealthPanel connection={c} />
        </TabsContent>
        <TabsContent value="mapping">
          <Card>
            <CardHeader title="Mapping" />
            <CardBody>
              <MappingTab key={JSON.stringify(c.mapping ?? {})} c={c} />
            </CardBody>
          </Card>
        </TabsContent>
        <TabsContent value="config">
          <ConfigTab c={c} />
        </TabsContent>
        <TabsContent value="settings">
          <SettingsTab c={c} />
        </TabsContent>
        {showWebhook ? (
          <TabsContent value="webhook">
            <WebhookPanel url={c.webhookUrl} hasSecret={c.hasWebhookSecret} secret={secret} />
          </TabsContent>
        ) : null}
      </Tabs>
      <ConfirmDialog
        open={rotate}
        onOpenChange={setRotate}
        title={c.hasWebhookSecret ? 'Rotate webhook secret?' : 'Create webhook secret?'}
        description={c.hasWebhookSecret ? 'Senders using the old secret are rejected.' : undefined}
        confirmLabel={c.hasWebhookSecret ? 'Rotate' : 'Create'}
        destructive={c.hasWebhookSecret}
        onConfirm={async () => {
          const next = generateSecret();
          await actions.update.mutateAsync({ webhookSecret: next });
          setSecret(next);
          setTab('webhook');
          toast.success('Secret saved');
        }}
      />
      <TypedConfirmDialog
        open={del}
        onOpenChange={setDel}
        title="Delete connection?"
        description="Bound passes keep their data and stop syncing."
        word={confirmWord({ title: c.name })}
        confirmLabel="Delete connection"
        onConfirm={async () => {
          await actions.remove.mutateAsync();
          toast.success('Connection deleted');
          void navigate({ to: '/admin/connections' });
        }}
      />
    </>
  );
}
