import { useCallback, useEffect, useMemo, useState } from 'react';
import type { WebhookEndpointDto } from '../../../shared/contracts/webhooks.ts';
import { BENCH_WEBHOOKS_COPY } from '../../../shared/copy/developers-bench-webhooks.ts';
import { WEBHOOKS_COPY } from '../../../shared/copy/developers-webhooks.ts';
import { PATHS } from '../../../shared/developers.ts';
import { copyWithFeedback } from '../../developers/shell/copy.ts';
import { type Revealed, RevealSheet } from '../../developers/ui/reveal-sheet.tsx';
import { pluralize } from '../../lib/format.ts';
import { useMediaQuery } from '../../lib/media.ts';
import { useBenchKeys } from '../bench/keys.ts';
import { BenchList } from '../bench/list.tsx';
import { LiveIndicator, useLiveState } from '../bench/live.tsx';
import { BenchSlot } from '../bench/slots.tsx';
import { BENCH_WIDE, BenchSplit } from '../bench/split.tsx';
import { BenchState } from '../bench/state.tsx';
import { useBenchFilters } from '../bench/use-filters.ts';
import { useBenchSelection } from '../bench/use-selection.ts';
import type { ApiProblem, TesterApi } from './client.ts';
import { ManageSheet } from './endpoints.tsx';
import { locate, useFeed } from './feed.ts';
import { curlOf } from './format.ts';
import { WebhookInspector } from './inspector.tsx';
import { narrow, type Row, toneOfRow } from './model.ts';
import { EmptyList, rowParts } from './rows.tsx';
import { SendButton, TEST_TYPE } from './send.tsx';
import { FILTERS, WebhookToolbar } from './toolbars.tsx';

const C = BENCH_WEBHOOKS_COPY;
const _F = C.filters;
const ROTATE_OVERLAP_MS = 24 * 3_600_000;
const idOf = (r: Row) => r.id;

const messageOf = (e: unknown) =>
  (e as ApiProblem).status === 429
    ? C.errors.tooMany
    : e instanceof Error
      ? e.message
      : C.errors.generic;

export function Workspace({ api, types }: { api: TesterApi; types: readonly string[] }) {
  const [endpoints, setEndpoints] = useState<WebhookEndpointDto[]>([]);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const wide = useMediaQuery(BENCH_WIDE);
  const where = useBenchFilters(['endpoint'] as const);
  const filters = useBenchFilters(FILTERS);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is Retry.
  useEffect(() => {
    let live = true;
    setFailed(false);
    void (async () => {
      try {
        const list = await api.endpoints();
        const cap = list.find((e) => e.target === 'capture') ?? (await api.ensureCapture());
        if (live) setEndpoints([cap, ...list.filter((e) => e.target !== 'capture')]);
      } catch (e) {
        if (live) {
          setFailed(true);
          setMessage(messageOf(e));
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [api, attempt]);

  const endpoint =
    endpoints.find((e) => e.id === where.values.endpoint) ??
    endpoints.find((e) => e.target === 'capture') ??
    null;
  const { values } = filters;
  const feed = useFeed(api, endpoint, {
    ...(values.type ? { type: values.type } : {}),
    ...(values.request ? { requestId: values.request } : {}),
    ...(values.pass ? { passId: values.pass } : {}),
  });
  const rows = useMemo(
    () => narrow(feed.rows, { type: values.type, status: values.status }),
    [feed.rows, values.type, values.status],
  );
  const fetchOne = useCallback((id: string) => locate(api, endpoints, id), [api, endpoints]);
  const selection = useBenchSelection({ items: rows, idOf, fetchOne, ready: feed.ready });
  const { selectedId, selected, pinned, select, step } = selection;
  const live = useLiveState(feed.paused);

  // `#<event id>` names a capture by its event; a row on another endpoint takes that endpoint.
  useEffect(() => {
    if (!feed.ready || !selectedId || rows.some((r) => r.id === selectedId)) return;
    const named = rows.find((r) => r.eventId === selectedId);
    if (named) select(named.id, { open: true });
  }, [feed.ready, rows, selectedId, select]);
  const elsewhere =
    pinned && endpoint && pinned.endpointId !== endpoint.id ? pinned.endpointId : null;
  useEffect(() => {
    if (elsewhere) where.set('endpoint', elsewhere);
  }, [elsewhere, where.set]);
  // Wide, the pane is always there: it opens on the newest delivery.
  const first = rows[0];
  useEffect(() => {
    if (wide && feed.ready && !selectedId && first) select(first.id, { open: false });
  }, [wide, feed.ready, selectedId, first, select]);

  const secretOf = endpoint?.id;
  const loadSecret = useCallback(
    () => (secretOf ? api.secret(secretOf) : Promise.reject(new Error('none'))),
    [api, secretOf],
  );

  async function act(run: () => Promise<string | null>) {
    setBusy(true);
    setMessage(null);
    try {
      const next = await run();
      await feed.reload();
      if (next) select(next, { open: true });
    } catch (e) {
      setMessage(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  const sendTest = async (type: string): Promise<string | null> => {
    if (!endpoint) return null;
    const r = await api.sendTest(endpoint.id, type);
    if (endpoint.target === 'url')
      setMessage(
        r.ok
          ? null
          : r.status === null
            ? C.errors.unreachable(r.errorCode ?? 'no answer')
            : C.errors.answered(r.status),
      );
    return r.captureId;
  };
  const send = (type: string = TEST_TYPE) => void act(() => sendTest(type));
  const replay = () => {
    if (!endpoint || !selected) return;
    void act(async () => {
      if (selected.kind === 'capture') return (await api.replay(endpoint.id, selected.id)).id;
      if (selected.eventId) await api.replayDelivery(endpoint.id, selected.eventId);
      return null;
    });
  };
  useBenchKeys({
    primary: () => send(),
    copyId: () => selected?.eventId && void copyWithFeedback(selected.eventId, null),
    copyCurl: () => selected?.capture && void copyWithFeedback(curlOf(selected.capture), null),
  });

  /** An endpoint's id, or null for the capture endpoint (the default, so it leaves the address). */
  const pickEndpoint = (id: string | null) => {
    where.set('endpoint', id);
    select(null);
    setMessage(null);
  };

  if (failed && !endpoint)
    return (
      <BenchState scene="failed" onRetry={() => setAttempt((n) => n + 1)}>
        {message ? <span className="muted">{message}</span> : null}
      </BenchState>
    );
  if (!endpoint) return null;

  const empty = (
    <EmptyList narrowed={filters.active > 0} busy={busy} onClear={filters.clear} onSend={send} />
  );
  const order = [...(pinned ? [pinned] : []), ...rows];
  const at = selected ? order.findIndex((r) => r.id === selected.id) : -1;

  return (
    <>
      <BenchSlot name="count">
        <span className="wh-count">{pluralize(endpoints.length, C.count.endpoint)}</span>
      </BenchSlot>
      <BenchSlot name="action">
        <SendButton types={types} busy={busy} onSend={send} />
      </BenchSlot>
      <LiveIndicator state={live} onResume={feed.resume} />
      <WebhookToolbar
        endpoints={endpoints}
        endpoint={endpoint}
        types={types}
        onEndpoint={(id) => pickEndpoint(id || null)}
        onManage={() => setManaging(true)}
        filters={filters}
      />
      {message ? (
        <p className="wh-msg" role="alert">
          {message}
        </p>
      ) : null}
      <BenchSplit
        bare
        label={C.list}
        open={selection.open}
        onClose={() => selection.setOpen(false)}
        main={
          feed.failed ? (
            <BenchState scene="failed" onRetry={() => void feed.reload()} />
          ) : feed.ready ? (
            <BenchList
              label={C.list}
              items={rows}
              idOf={idOf}
              selection={selection}
              fresh={feed.fresh}
              empty={empty}
              tone={toneOfRow}
              row={rowParts}
              footer={{ count: C.count.deliveries(rows.length) }}
            />
          ) : null
        }
        pane={
          selected ? (
            <WebhookInspector
              api={api}
              row={selected}
              busy={busy}
              loadSecret={loadSecret}
              onReplay={replay}
              onPrev={at > 0 ? () => step(-1) : undefined}
              onNext={at >= 0 && at < order.length - 1 ? () => step(1) : undefined}
            />
          ) : null
        }
      />
      <p className="bench-note">
        {C.note.kept} · <a href={`${PATHS.guides}/react-to-events`}>{C.note.types}</a>
      </p>
      {managing ? (
        <ManageSheet
          endpoints={endpoints}
          current={endpoint}
          onPick={(id) => {
            pickEndpoint(endpoints.find((e) => e.id === id)?.target === 'capture' ? null : id);
            setManaging(false);
          }}
          onClose={() => setManaging(false)}
          onCreate={async (url) => {
            const made = await api.createEndpoint(
              url,
              types.filter((t) => t !== 'webhook.test'),
            );
            setEndpoints((l) => [...l, made.endpoint]);
            pickEndpoint(made.endpoint.id);
            setManaging(false);
            setRevealed({ name: WEBHOOKS_COPY.reveal.env, secret: made.secret });
          }}
          onRotate={async () => {
            setMessage(null);
            const secret = await api.rotate(endpoint.id, 24);
            setManaging(false);
            setRevealed({
              name: WEBHOOKS_COPY.reveal.env,
              secret,
              stopsAt: Date.now() + ROTATE_OVERLAP_MS,
            });
          }}
        />
      ) : null}
      {revealed ? (
        <RevealSheet
          revealed={revealed}
          labels={WEBHOOKS_COPY.reveal}
          onDone={() => setRevealed(null)}
          // The sheet holds the only copy from here on.
          onHide={() => setRevealed((r) => (r ? { ...r, secret: null } : r))}
        />
      ) : null}
    </>
  );
}
