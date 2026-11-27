import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { Plus, Send } from 'lucide-react';
import { useEffect, useState } from 'react';
import { wbEventsPath } from '@/shared/workbench.ts';
import { errorMessage } from '../../lib/errors.ts';
import { Button } from '../../ui/button.tsx';
import { SegmentedControl } from '../../ui/segmented-control.tsx';
import { toast } from '../../ui/toaster.tsx';
import { useBenchKeys } from '../bench/keys.ts';
import { BenchSkeleton } from '../bench/skeleton.tsx';
import { useToolHost } from '../host/tool-host.tsx';
import { ToolPage } from '../shell/tool-page.tsx';
import { ToolEmpty, ToolFailed } from '../states/states.tsx';
import { EndpointsPanel } from './endpoints-panel.tsx';
import { EventsPanel } from './events-panel.tsx';
import { useAddress } from './use-address.ts';
import { useEndpoints, useEventsApi } from './use-events.ts';

const TABS = [
  { value: 'events', label: 'Events' },
  { value: 'endpoints', label: 'Endpoints' },
] as const;

/**
 * Events (design §1.10): the event feed with each event's deliveries and captures, and the
 * Endpoints tab; Add endpoint opens the Connections wizard's outbound path in admin and comes back here.
 * Everything runs on the Workbench token through the tool scope.
 */
export function EventsTool({ className }: { className: string }) {
  const { context } = useToolHost();
  const orgId = context.orgId;
  const router = useRouter();
  const qc = useQueryClient();
  const api = useEventsApi();
  const { params, write } = useAddress();
  const endpoints = useEndpoints();
  const list = endpoints.data;

  // A sandbox always has its capture endpoint: make it once if an older sandbox lacks it.
  const lacksCapture =
    context.kind === 'sandbox' && list !== undefined && !list.some((e) => e.target === 'capture');
  useEffect(() => {
    if (!lacksCapture) return;
    api
      .ensureCapture()
      .then(() => qc.invalidateQueries({ queryKey: ['workbench', 'events', 'endpoints'] }))
      .catch(() => undefined);
  }, [lacksCapture, api, qc]);

  const tab = (value: 'events' | 'endpoints') =>
    router.history.push(wbEventsPath(orgId, value === 'endpoints' ? { tab: 'endpoints' } : {}));

  /** The one outbound wizard lives in admin; it returns here with the new endpoint selected. */
  const addHref = `/admin/o/${encodeURIComponent(orgId)}/connections/new?${new URLSearchParams({
    source: 'outbound',
    mode: 'test',
    return: wbEventsPath(orgId, { tab: 'endpoints' }),
  })}`;
  const openAdd = () => window.location.assign(addHref);

  /** Sends a test event to the built-in capture endpoint, or the first active URL endpoint, then shows it. */
  async function sendTest() {
    const target =
      list?.find((e) => e.target === 'capture') ?? list?.find((e) => e.status === 'active');
    if (!target) return openAdd();
    try {
      const r = await api.sendTest(target.id, 'webhook.test');
      await qc.invalidateQueries({ queryKey: ['workbench', 'events'] });
      router.history.push(wbEventsPath(orgId, { tab: 'endpoints', endpoint: target.id }));
      if (r.captureId) write({ capture: r.captureId }, 'replace');
      if (r.ok) toast.success('Test event sent');
      else toast.error('The endpoint did not accept it.', 'Could not deliver');
    } catch (error) {
      toast.error(errorMessage(error), 'Could not send');
    }
  }

  // ⌘↵ is the visible action: Add endpoint while the empty state shows, else send a test event (design §5.4).
  const [emptyNow, setEmptyNow] = useState(false);
  useBenchKeys({ primary: () => (emptyNow ? openAdd() : void sendTest()) });

  const empty = <ToolEmpty tool="events" />;
  const sendAction = (
    <Button variant="outline" onClick={() => void sendTest()} iconStart={<Send aria-hidden />}>
      Send test event
    </Button>
  );

  return (
    <ToolPage
      tool="events"
      primary={
        <Button asChild iconStart={<Plus aria-hidden />}>
          <a href={addHref}>Add endpoint</a>
        </Button>
      }
    >
      <div className={`${className} flex flex-col gap-3`}>
        <SegmentedControl
          label="Events view"
          options={TABS}
          value={params.tab}
          onValueChange={tab}
          className="self-start"
        />
        {endpoints.isPending ? (
          <BenchSkeleton rows={6} />
        ) : endpoints.isError || !list ? (
          <ToolFailed error={endpoints.error} onRetry={() => void endpoints.refetch()} />
        ) : params.tab === 'endpoints' ? (
          <EndpointsPanel
            endpoints={list}
            params={params}
            write={write}
            selectNew={undefined}
            focusSend={false}
            empty={empty}
          />
        ) : (
          <EventsPanel
            orgId={orgId}
            params={params}
            endpoints={list}
            write={write}
            empty={empty}
            sendAction={sendAction}
            onEmpty={setEmptyNow}
          />
        )}
      </div>
    </ToolPage>
  );
}
