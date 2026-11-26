import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pause, Play, RotateCw, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { WebhookCaptureDto } from '@/shared/contracts/webhook-captures.ts';
import { WEBHOOK_EVENT_TYPES, type WebhookEndpointDto } from '@/shared/contracts/webhooks.ts';
import { WEBHOOKS_COPY } from '@/shared/copy/developers-webhooks.ts';
import { Deliveries } from '../../admin/connections/webhooks/deliveries.tsx';
import { type Revealed, RevealSheet } from '../../developers/ui/reveal-sheet.tsx';
import { StepUp } from '../../developers/ui/step-up.tsx';
import { errorMessage } from '../../lib/errors.ts';
import { toast } from '../../ui/toaster.tsx';
import { DeliveryList } from '../../ui/webhooks/delivery-list.tsx';
import { IdChip } from '../bench/id-chip.tsx';
import { Inspector } from '../bench/inspector.tsx';
import { StatusChip } from '../bench/status-chip.tsx';
import { BenchTime } from '../bench/time.tsx';
import { stepUpOf } from './api.ts';
import { CaptureView } from './capture-view.tsx';
import { captureRow, endpointLabel } from './model.ts';
import { SendButton } from './send.tsx';
import { useCaptures, useDeliveryHost, useEventsApi } from './use-events.ts';

const TYPES = ['webhook.test', ...WEBHOOK_EVENT_TYPES.filter((t) => t !== 'webhook.test')];
const OLD_SECRET_MS = 24 * 3_600_000;

export const SEND_TEST_ID = 'wb-send-test';

/** The ways an endpoint's calls fail that are worth a sentence of their own: a step-up, else the message. */
function useGuarded() {
  const [stepUp, setStepUp] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return {
    stepUp,
    error,
    reset: () => {
      setStepUp(null);
      setError(null);
    },
    fail: (cause: unknown) => {
      const asked = stepUpOf(cause);
      if (asked !== null) setStepUp(asked);
      else setError(errorMessage(cause));
    },
  };
}

/**
 * One endpoint: its status and what it subscribes to, Send test event, Pause or Resume, Rotate and
 * Delete (a URL endpoint's), then its deliveries in the shared list. A capture endpoint lists what it
 * stored instead and opens a stored request in place.
 */
export function EndpointInspector({
  endpoint,
  capture: openCapture,
  onCapture,
  focusSend,
  onGone,
  onPrev,
  onNext,
}: {
  endpoint: WebhookEndpointDto;
  /** `?capture=`: the stored request open under the list. */
  capture: string | undefined;
  onCapture: (id: string | undefined) => void;
  /** Focus Send test event on arrival (the finish of Add endpoint). */
  focusSend: boolean;
  onGone: () => void;
  onPrev?: (() => void) | undefined;
  onNext?: (() => void) | undefined;
}) {
  const api = useEventsApi();
  const qc = useQueryClient();
  const host = useDeliveryHost();
  const guard = useGuarded();
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<'rotate' | 'delete' | null>(null);
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const url = endpoint.target === 'url';
  const done = () => qc.invalidateQueries({ queryKey: ['workbench', 'events'] });

  // biome-ignore lint/correctness/useExhaustiveDependencies: focus again when another endpoint is selected
  useEffect(() => {
    if (focusSend) document.getElementById(SEND_TEST_ID)?.focus();
  }, [focusSend, endpoint.id]);

  async function run(work: () => Promise<void>) {
    guard.reset();
    setBusy(true);
    try {
      await work();
    } catch (cause) {
      guard.fail(cause);
    } finally {
      setBusy(false);
      setAsking(null);
    }
  }

  const send = (type: string) =>
    run(async () => {
      const r = await api.sendTest(endpoint.id, type);
      await done();
      if (r.captureId) onCapture(r.captureId);
      if (r.ok) toast.success(`Sent ${type}${r.status ? `: HTTP ${r.status}` : ''}.`);
      else
        toast.error(
          `The endpoint ${r.status ? `answered ${r.status}` : `did not answer (${r.errorCode ?? 'no answer'})`}.`,
          'Could not deliver',
        );
    });
  const toggle = () =>
    run(async () => {
      await api.update(endpoint.id, { status: endpoint.status === 'active' ? 'paused' : 'active' });
      await done();
    });
  const remove = () =>
    run(async () => {
      await api.remove(endpoint.id);
      await done();
      toast.success('Endpoint deleted');
      onGone();
    });
  const rotate = () =>
    run(async () => {
      const { secret } = await api.rotate(endpoint.id, 24);
      setRevealed({ name: WEBHOOKS_COPY.reveal.env, secret, stopsAt: Date.now() + OLD_SECRET_MS });
    });

  const tone = endpoint.status === 'active' ? 'success' : 'neutral';
  return (
    <Inspector
      title={endpointLabel(endpoint)}
      label={`Endpoint ${endpointLabel(endpoint)}`}
      itemKey={endpoint.id}
      status={<StatusChip tone={tone}>{endpoint.status}</StatusChip>}
      id={<IdChip id={endpoint.id} kind="id" />}
      actions={
        <>
          <SendButton id={SEND_TEST_ID} types={TYPES} busy={busy} onSend={(t) => void send(t)} />
          {url ? (
            <button
              type="button"
              className="btn ghost sm"
              disabled={busy}
              onClick={() => void toggle()}
            >
              {endpoint.status === 'active' ? (
                <Pause aria-hidden="true" />
              ) : (
                <Play aria-hidden="true" />
              )}
              {endpoint.status === 'active' ? 'Pause' : 'Resume'}
            </button>
          ) : null}
        </>
      }
      facts={
        <>
          <span>
            {endpoint.target === 'capture'
              ? 'Stored, never sent'
              : `${endpoint.eventTypes.length} events`}
          </span>
          <BenchTime at={endpoint.createdAt} mode="ago" />
          {endpoint.lastStatus ? <StatusChip status={endpoint.lastStatus} /> : null}
        </>
      }
      onPrev={onPrev}
      onNext={onNext}
    >
      <div className="flex flex-col gap-5">
        {guard.stepUp !== null ? (
          <StepUp
            signInUrl={guard.stepUp}
            next={`${location.pathname}${location.search}${location.hash}`}
          />
        ) : null}
        {guard.error ? (
          <p className="wh-msg" role="alert">
            {guard.error}
          </p>
        ) : null}
        {url ? (
          <div className="flex flex-wrap items-center gap-2">
            {asking === null ? (
              <>
                <button
                  type="button"
                  className="btn outline sm"
                  disabled={busy}
                  onClick={() => setAsking('rotate')}
                >
                  <RotateCw aria-hidden="true" />
                  Rotate secret
                </button>
                <button
                  type="button"
                  className="btn outline sm"
                  disabled={busy}
                  onClick={() => setAsking('delete')}
                >
                  <Trash2 aria-hidden="true" />
                  Delete
                </button>
              </>
            ) : (
              <>
                <span className="text-sm">
                  {asking === 'rotate'
                    ? WEBHOOKS_COPY.rotate.ask
                    : 'Delete this endpoint? Its deliveries go with it.'}
                </span>
                <button
                  type="button"
                  className="btn sm"
                  disabled={busy}
                  onClick={() => void (asking === 'rotate' ? rotate() : remove())}
                >
                  {asking === 'rotate' ? WEBHOOKS_COPY.rotate.confirm : 'Delete'}
                </button>
                <button type="button" className="btn ghost sm" onClick={() => setAsking(null)}>
                  Cancel
                </button>
              </>
            )}
          </div>
        ) : null}
        <section aria-label="Deliveries" className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-fg-strong">
            {url ? 'Deliveries' : 'Stored requests'}
          </h3>
          {url ? (
            <Deliveries
              endpointId={endpoint.id}
              canManage={host.canManage}
              endpointStatus={endpoint.status}
              host={host}
              inline
            />
          ) : (
            <Stored endpoint={endpoint} open={openCapture} onOpen={onCapture} />
          )}
        </section>
      </div>
      {revealed ? (
        <RevealSheet
          revealed={revealed}
          labels={WEBHOOKS_COPY.reveal}
          onDone={() => setRevealed(null)}
          // The sheet holds the only copy from here on.
          onHide={() => setRevealed((r) => (r ? { ...r, secret: null } : r))}
        />
      ) : null}
    </Inspector>
  );
}

/** What a capture endpoint stored, in the shared list; one opens in place. */
function Stored({
  endpoint,
  open,
  onOpen,
}: {
  endpoint: WebhookEndpointDto;
  open: string | undefined;
  onOpen: (id: string | undefined) => void;
}) {
  const api = useEventsApi();
  const qc = useQueryClient();
  const host = useDeliveryHost();
  const list = useCaptures(endpoint.id);
  const [replaying, setReplaying] = useState(false);
  const rows = useMemo(
    () => (list.data ?? []).map((c) => captureRow(c, endpoint)),
    [list.data, endpoint],
  );
  const found = useQuery({
    queryKey: ['workbench', 'events', 'stored', endpoint.id, open],
    queryFn: () => api.capture(endpoint.id, open as string),
    enabled: Boolean(open) && !(list.data ?? []).some((c) => c.id === open),
    retry: false,
  });
  const shown: WebhookCaptureDto | undefined =
    (list.data ?? []).find((c) => c.id === open) ?? found.data;
  return (
    <>
      <DeliveryList
        host={{ ...host, canManage: false }}
        rows={rows}
        endpointStatus={endpoint.status}
        loading={list.isPending}
        fetching={list.isFetching}
        error={list.isError ? list.error : undefined}
        onRetry={() => void list.refetch()}
        onOpen={(row) => 'rowId' in row && onOpen(row.rowId)}
        selected={open}
        onReplay={() => undefined}
        emptyTitle="Nothing stored yet"
        caption="Stored requests"
      />
      {shown ? (
        <CaptureView
          key={shown.id}
          capture={shown}
          loadSecret={() => api.captureSecret(endpoint.id)}
          next={`${location.pathname}${location.search}${location.hash}`}
          replaying={replaying}
          onReplay={() => {
            setReplaying(true);
            api
              .replayCapture(endpoint.id, shown.id)
              .then(async ({ capture }) => {
                await qc.invalidateQueries({ queryKey: ['workbench', 'events'] });
                toast.success('Replayed. A new request is stored.');
                onOpen(capture.id);
              })
              .catch((error: unknown) => toast.error(errorMessage(error), 'Could not replay'))
              .finally(() => setReplaying(false));
          }}
          onClose={() => onOpen(undefined)}
        />
      ) : null}
    </>
  );
}
