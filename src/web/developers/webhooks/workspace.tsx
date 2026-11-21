import { Copy, Plus, Send } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { WebhookCaptureDto } from '../../../shared/contracts/webhook-captures.ts';
import type { WebhookEndpointDto } from '../../../shared/contracts/webhooks.ts';
import { SDK_STATUS } from '../../../shared/developers-sdk.ts';
import type { ApiProblem, DeliveryDto, TestAttemptDto, TesterApi } from './client.ts';
import { Deliveries, type ListenState } from './deliveries.tsx';
import { Detail } from './detail.tsx';
import { AddEndpoint, Endpoints, RotateSecret } from './endpoints.tsx';
import { VERIFY_SAMPLES } from './samples.ts';
import { Samples } from './samples-tabs.tsx';
import { rowsOf, UrlDetail, UrlEvents } from './url-events.tsx';

const CLI = 'npx @passbook/cli listen --forward-to localhost:3000/hooks';

const POLL_MS = 3000;

export function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card card-b stack g2" role="status">
      <h2 className="h3">{title}</h2>
      <div className="muted">{children}</div>
    </div>
  );
}

const messageOf = (e: unknown) =>
  (e as ApiProblem).status === 429
    ? 'Too many sends. Wait a minute and try again.'
    : e instanceof Error
      ? e.message
      : 'Something went wrong. Try again.';

function Localhost() {
  return (
    <div className="card card-b stack g2">
      <div className="xs muted">Forward to your machine</div>
      <div className="cmd">
        <span className="p">$</span>
        <code>{CLI}</code>
        <button type="button" className="iconbtn copy push" data-copy aria-label="Copy command">
          <Copy className="lucide" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export function Workspace({ api, types }: { api: TesterApi; types: readonly string[] }) {
  const [endpoint, setEndpoint] = useState<WebhookEndpointDto | null>(null);
  const [all, setAll] = useState<WebhookEndpointDto[]>([]);
  const [captures, setCaptures] = useState<WebhookCaptureDto[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [sendType, setSendType] = useState('webhook.test');
  const [listen, setListen] = useState<ListenState>('listening');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [failed, setFailed] = useState<string | null>(null);
  const [urlDeliveries, setUrlDeliveries] = useState<DeliveryDto[]>([]);
  const [urlTests, setUrlTests] = useState<TestAttemptDto[]>([]);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const list = await api.endpoints();
        const cap = list.find((e) => e.target === 'capture') ?? (await api.ensureCapture());
        const found = [cap, ...list.filter((e) => e.target !== 'capture')];
        if (!live) return;
        setAll(found);
        setEndpoint(cap);
      } catch (e) {
        if (live) setFailed(messageOf(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [api]);

  const id = endpoint?.id;
  const isUrl = endpoint?.target === 'url';
  const load = useCallback(async () => {
    if (!id) return;
    try {
      if (isUrl) {
        const [d, t] = await Promise.all([api.deliveries(id), api.tests(id)]);
        setUrlDeliveries(d);
        setUrlTests(t);
      } else setCaptures(await api.captures(id, filter || undefined));
      setListen('listening');
    } catch {
      setListen('offline');
    }
    setNow(Date.now());
  }, [api, id, filter, isUrl]);

  useEffect(() => {
    void load();
    const tick = () => {
      if (document.hidden) setListen('paused');
      else void load();
    };
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [load]);

  const loadSecret = useCallback(
    () => (id ? api.secret(id) : Promise.reject(new Error('none'))),
    [api, id],
  );
  const selected = captures.find((c) => c.id === picked) ?? captures[0] ?? null;

  async function act(run: () => Promise<string | null>) {
    setBusy(true);
    setMessage(null);
    try {
      const next = await run();
      if (next) setPicked(next);
      await load();
    } catch (e) {
      setMessage(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  const rows = rowsOf(urlDeliveries, urlTests);
  const urlRow = rows.find((r) => r.key === picked) ?? rows[0] ?? null;

  function pick(next: string) {
    setEndpoint(all.find((x) => x.id === next) ?? endpoint);
    setPicked(null);
    setMessage(null);
  }

  async function sendTest(): Promise<string | null> {
    if (!endpoint) return null;
    const r = await api.sendTest(endpoint.id, sendType);
    if (endpoint.target === 'url')
      setMessage(
        r.ok
          ? null
          : r.status === null
            ? `Could not reach the endpoint (${r.errorCode ?? 'no answer'}).`
            : `The endpoint answered ${r.status}.`,
      );
    return r.captureId;
  }

  async function create(url: string): Promise<string> {
    const made = await api.createEndpoint(
      url,
      types.filter((t) => t !== 'webhook.test'),
    );
    setAll((l) => [...l, made.endpoint]);
    setEndpoint(made.endpoint);
    setPicked(null);
    return made.secret;
  }

  if (failed) return <Notice title="Could not open the tester">{failed}</Notice>;
  if (!endpoint) return <Notice title="Opening your sandbox">One moment.</Notice>;
  return (
    <>
      <div className="wh-bar">
        <label className="wh-select wh-type">
          <span className="sr">Event type to send</span>
          <select value={sendType} onChange={(e) => setSendType(e.target.value)}>
            {types.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn outline"
          disabled={busy}
          onClick={() => void act(() => sendTest())}
        >
          <Send aria-hidden="true" />
          Send test event
        </button>
        <button type="button" className="btn" onClick={() => setAdding(true)}>
          <Plus aria-hidden="true" />
          Add endpoint
        </button>
      </div>
      {message ? (
        <p className="wh-msg" role="alert">
          {message}
        </p>
      ) : null}
      <div className="wh-grid">
        <div className="stack g4">
          {adding ? <AddEndpoint onCreate={create} onClose={() => setAdding(false)} /> : null}
          <Endpoints list={all} selected={endpoint.id} onSelect={pick} />
          {isUrl ? (
            <RotateSecret
              key={endpoint.id}
              rotate={() => {
                setMessage(null);
                return api.rotate(endpoint.id, 24);
              }}
            />
          ) : null}
          {isUrl ? (
            <UrlEvents rows={rows} selected={urlRow?.key ?? null} onSelect={setPicked} now={now} />
          ) : (
            <Deliveries
              captures={captures}
              selected={selected?.id ?? null}
              onSelect={setPicked}
              filter={filter}
              onFilter={setFilter}
              types={types}
              listen={listen}
              now={now}
            />
          )}
          {SDK_STATUS.cli ? <Localhost /> : null}
        </div>
        <div className="stack g4">
          {isUrl ? (
            urlRow ? (
              <UrlDetail
                api={api}
                endpointId={endpoint.id}
                row={urlRow}
                onReplayed={() => void load()}
              />
            ) : (
              <Notice title="Nothing to inspect">Send a test event to this endpoint.</Notice>
            )
          ) : selected ? (
            <Detail
              capture={selected}
              busy={busy}
              loadSecret={loadSecret}
              onReplay={() => void act(async () => (await api.replay(endpoint.id, selected.id)).id)}
            />
          ) : (
            <Notice title="Nothing to inspect">
              Send a test event, or issue a pass in your sandbox.
            </Notice>
          )}
          {isUrl ? null : <Samples samples={VERIFY_SAMPLES} />}
        </div>
      </div>
    </>
  );
}
