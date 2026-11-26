import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { Plus, Send } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { WebhookEndpointDto } from '@/shared/contracts/webhooks.ts';
import { wbEventsPath } from '@/shared/workbench.ts';
import { errorMessage } from '../../lib/errors.ts';
import { Button } from '../../ui/button.tsx';
import { SegmentedControl } from '../../ui/segmented-control.tsx';
import { toast } from '../../ui/toaster.tsx';
import { useBenchKeys } from '../bench/keys.ts';
import { BenchSkeleton } from '../bench/skeleton.tsx';
import { BenchSlot } from '../bench/slots.tsx';
import { useToolHost } from '../host/tool-host.tsx';
import { ToolPage } from '../shell/tool-page.tsx';
import { ToolEmpty, ToolFailed } from '../states/states.tsx';
import { EndpointsPanel } from './endpoints-panel.tsx';
import { EventsPanel } from './events-panel.tsx';
import { useAddress } from './use-address.ts';
import { useEndpoints, useEventsApi } from './use-events.ts';

// The wizard is its own chunk: it opens only on Add endpoint.
const AddEndpointWizard = lazy(() => import('./add-endpoint.tsx'));

const TABS = [
  { value: 'events', label: 'Events' },
  { value: 'endpoints', label: 'Endpoints' },
] as const;

/**
 * Events (design §1.10): the event feed with each event's deliveries and captures, and the
 * Endpoints tab with the Connections wizard's outbound path mounted in this context's Test.
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
  const [seen, setSeen] = useState(params.add);
  const [added, setAdded] = useState<string>();
  const pushed = useRef(false);
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

  const openAdd = useCallback(() => {
    pushed.current = true;
    setSeen(true);
    router.history.push(wbEventsPath(orgId, { tab: 'endpoints', add: true }));
  }, [router, orgId]);
  /** Cancel or Esc: Back when the wizard pushed its entry, else the entry is replaced. */
  const closeAdd = useCallback(() => {
    if (pushed.current) {
      pushed.current = false;
      router.history.back();
    } else write({ new: null }, 'replace');
  }, [router, write]);
  const onFinish = useCallback(
    (endpoint: WebhookEndpointDto) => {
      pushed.current = false;
      void qc.invalidateQueries({ queryKey: ['workbench', 'events'] });
      router.history.replace(wbEventsPath(orgId, { tab: 'endpoints', endpoint: endpoint.id }));
      setAdded(endpoint.id);
      toast.success('Endpoint added');
    },
    [router, orgId, qc],
  );

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

  // ⌘↵ sends a test event, as the tool's one action (design §5.4).
  useBenchKeys({ primary: () => void sendTest() });

  const empty = (
    <ToolEmpty
      tool="events"
      action={
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="outline" onClick={openAdd} iconStart={<Plus aria-hidden />}>
            Add endpoint
          </Button>
          <Button
            variant="outline"
            onClick={() => void sendTest()}
            iconStart={<Send aria-hidden />}
          >
            Send a test event
          </Button>
        </div>
      }
    />
  );

  return (
    <ToolPage
      tool="events"
      primary={
        <Button onClick={openAdd} iconStart={<Plus aria-hidden />}>
          Add endpoint
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
            selectNew={added}
            focusSend={added !== undefined}
            empty={empty}
          />
        ) : (
          <>
            <BenchSlot name="action">
              <Button
                variant="outline"
                onClick={() => void sendTest()}
                iconStart={<Send aria-hidden />}
              >
                Send test event
              </Button>
            </BenchSlot>
            <EventsPanel
              orgId={orgId}
              params={params}
              endpoints={list}
              write={write}
              empty={empty}
            />
          </>
        )}
      </div>
      {seen ? (
        <Suspense fallback={null}>
          <AddEndpointWizard
            open={params.add}
            onOpenChange={(open) => !open && closeAdd()}
            onFinish={onFinish}
          />
        </Suspense>
      ) : null}
    </ToolPage>
  );
}
