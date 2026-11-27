import { Link, useNavigate } from '@tanstack/react-router';
import { Pause, Play, RotateCw } from 'lucide-react';
import { useState } from 'react';
import type { WebhookEndpointDto } from '@/shared/contracts/webhooks.ts';
import { ACTION_ICON } from '../../../lib/action-icons.ts';
import { deleteConfirm } from '../../../lib/confirms.ts';
import { formatDateTime } from '../../../lib/format.ts';
import { useMode } from '../../../lib/mode.ts';
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  DropdownMenuItem,
  KeyValue,
  MoreMenu,
  PageHeader,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  TwoPane,
  toast,
  useNow,
} from '../../../ui/index.ts';
import { OpenInWorkbench } from '../../../ui/layout/open-in-workbench.tsx';
import { LiveCheck } from '../../../ui/webhook-setup/index.ts';
import { useEndpointActions } from './api.ts';
import { Deliveries } from './deliveries.tsx';
import type { EndpointTab } from './detail-tabs.ts';
import { EndpointStatus } from './endpoint-status.tsx';
import { endpointHost, endpointState, lastDelivery, spanLabel } from './health.ts';
import { ReplayDialog } from './replay-dialog.tsx';
import { RotateDialog } from './rotate-dialog.tsx';
import { SettingsCard } from './settings-card.tsx';
import { SigningCard } from './signing-card.tsx';

/** The one sentence a state needs; the pill says which state, this says what to do. */
function StateCallout({
  e,
  busy,
  onResume,
  onReplay,
  canManage,
}: {
  e: WebhookEndpointDto;
  busy: boolean;
  onResume: () => void;
  onReplay: () => void;
  canManage: boolean;
}) {
  const state = endpointState(e);
  const hasDeliveries = lastDelivery(e) !== null;
  if (state === 'untested')
    return (
      <Callout
        actions={
          canManage ? (
            <Button asChild size="sm">
              <Link
                to="/admin/connections/webhooks/$endpointId/setup"
                params={{ endpointId: e.id }}
              >
                Finish setup
              </Link>
            </Button>
          ) : undefined
        }
      >
        No test or delivery has succeeded yet.
      </Callout>
    );
  if (state === 'active') return null;
  const actions = canManage ? (
    <>
      <Button size="sm" loading={busy} iconStart={<Play aria-hidden />} onClick={onResume}>
        Resume
      </Button>
      {state === 'disabled' && hasDeliveries ? (
        <Button size="sm" variant="outline" iconStart={<RotateCw aria-hidden />} onClick={onReplay}>
          Replay failed
        </Button>
      ) : null}
    </>
  ) : undefined;
  if (state === 'disabled') {
    const after =
      e.disabledAt !== null && e.failingSince !== null
        ? ` after ${spanLabel(e.disabledAt - e.failingSince)} of failed deliveries`
        : ' after repeated failed deliveries';
    return (
      <Callout tone="danger" actions={actions}>
        {`Disabled${after}. Fix the endpoint, then resume.`}
      </Callout>
    );
  }
  if (state === 'paused')
    return <Callout actions={actions}>Nothing is sent until you resume.</Callout>;
  return (
    <Callout tone="warning" title="Deliveries are failing">
      PassBook retries for up to 3 days, then disables the endpoint.
    </Callout>
  );
}

export function EndpointDetail({
  endpoint: e,
  canManage,
  tab = 'overview',
}: {
  endpoint: WebhookEndpointDto;
  canManage: boolean;
  tab?: EndpointTab | undefined;
}) {
  const navigate = useNavigate();
  const mode = useMode();
  const now = useNow();
  const actions = useEndpointActions(e.id);
  const [replay, setReplay] = useState(false);
  const [rotate, setRotate] = useState(false);
  const [del, setDel] = useState(false);
  const host = endpointHost(e);
  const paused = e.status === 'paused';
  const setTab = (next: string) =>
    void navigate({ to: '.', search: { tab: next as EndpointTab }, replace: true });

  const setStatus = (status: 'active' | 'paused') =>
    actions.update
      .mutateAsync({ status })
      .then(() => toast.success(status === 'active' ? 'Resumed' : 'Paused'))
      .catch((error: unknown) =>
        toast.error(error, status === 'active' ? 'Could not resume' : 'Could not pause'),
      );

  return (
    <>
      <PageHeader
        title={host}
        breadcrumbs={[
          { label: 'Connections', to: '/admin/connections', search: { tab: 'webhooks' } },
          { label: host },
        ]}
        meta={
          <>
            <EndpointStatus endpoint={e} now={now} />
            {e.description ? <span>{e.description}</span> : null}
          </>
        }
        actions={
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <OpenInWorkbench tool="events" options={{ query: { tab: 'endpoints' }, hash: e.id }} />
            {canManage ? (
              <>
                {lastDelivery(e) !== null ? (
                  <Button
                    variant="outline"
                    iconStart={<RotateCw aria-hidden />}
                    onClick={() => setReplay(true)}
                  >
                    Replay
                  </Button>
                ) : null}
                <MoreMenu>
                  <DropdownMenuItem
                    disabled={e.status === 'disabled'}
                    onSelect={() => void setStatus(paused ? 'active' : 'paused')}
                  >
                    {paused ? <Play aria-hidden /> : <Pause aria-hidden />}
                    {paused ? 'Resume' : 'Pause'}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setRotate(true)}>
                    <ACTION_ICON.rotate aria-hidden />
                    Rotate secret
                  </DropdownMenuItem>
                  <DropdownMenuItem destructive onSelect={() => setDel(true)}>
                    <ACTION_ICON.delete aria-hidden />
                    Delete
                  </DropdownMenuItem>
                </MoreMenu>
              </>
            ) : null}
          </div>
        }
      />
      <div className="mb-6 empty:hidden">
        <StateCallout
          e={e}
          busy={actions.update.isPending}
          canManage={canManage}
          onResume={() => void setStatus('active')}
          onReplay={() => setReplay(true)}
        />
      </div>
      <Tabs value={tab} onValueChange={setTab} className="min-w-0">
        <TabsList aria-label="Webhook sections">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="deliveries">Deliveries</TabsTrigger>
          <TabsTrigger value="signing">Signing</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <TwoPane
            asideFirst
            aside={
              <>
                <Card>
                  <CardHeader title="Details" />
                  <CardBody>
                    <KeyValue
                      items={[
                        { label: 'Mode', value: mode === 'test' ? 'Test' : 'Live' },
                        { label: 'API version', value: e.apiVersion, mono: true },
                        {
                          label: 'Last success',
                          value: formatDateTime(e.lastSuccessAt, 'None yet'),
                        },
                        { label: 'Last failure', value: formatDateTime(e.lastFailureAt, 'None') },
                        { label: 'Added', value: formatDateTime(e.createdAt) },
                      ]}
                    />
                  </CardBody>
                </Card>
                <LiveCheck
                  mode="send"
                  host={host}
                  canSend={canManage}
                  send={() => actions.test.mutateAsync()}
                />
              </>
            }
          >
            <SettingsCard
              key={JSON.stringify([e.url, e.description, e.eventTypes, e.templateIds])}
              endpoint={e}
              canManage={canManage}
            />
          </TwoPane>
        </TabsContent>
        <TabsContent value="deliveries">
          <Card>
            <CardHeader title="Deliveries" />
            <CardBody>
              <Deliveries endpointId={e.id} canManage={canManage} endpointStatus={e.status} />
            </CardBody>
          </Card>
        </TabsContent>
        <TabsContent value="signing">
          <SigningCard endpoint={e} canManage={canManage} onRotate={() => setRotate(true)} />
        </TabsContent>
      </Tabs>
      {canManage ? (
        <>
          <ReplayDialog endpointId={e.id} open={replay} onOpenChange={setReplay} />
          <RotateDialog endpointId={e.id} open={rotate} onOpenChange={setRotate} />
          <ConfirmDialog
            open={del}
            onOpenChange={setDel}
            {...deleteConfirm('webhook', host)}
            destructive
            onConfirm={async () => {
              await actions.remove.mutateAsync();
              toast.success('Endpoint deleted');
              void navigate({
                to: '/admin/connections',
                search: { tab: 'webhooks' },
                replace: true,
              });
            }}
          />
        </>
      ) : null}
    </>
  );
}
