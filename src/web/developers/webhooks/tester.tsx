import { Copy, Inbox, Send } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { WebhookCaptureDto } from '../../../shared/contracts/webhook-captures.ts';
import type { WebhookEndpointDto } from '../../../shared/contracts/webhooks.ts';
import type { ApiProblem, TesterApi, TesterAuth } from './client.ts';
import { Deliveries, type ListenState } from './deliveries.tsx';
import { Detail } from './detail.tsx';
import { VERIFY_SAMPLES } from './samples.ts';
import { Samples } from './samples-tabs.tsx';

export const POLL_MS = 3000;
const CLI = 'npx @passbook/cli listen --forward-to localhost:3000/hooks';

const SIGN_IN = '/login?next=%2Fdevelopers%2Fwebhooks';

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
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

function Workspace({ api, types }: { api: TesterApi; types: readonly string[] }) {
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

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const list = (await api.endpoints()).filter((e) => e.target === 'capture');
        const found = list.length > 0 ? list : [await api.ensureCapture()];
        if (!live) return;
        setAll(found);
        setEndpoint(found[0] ?? null);
      } catch (e) {
        if (live) setFailed(messageOf(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [api]);

  const id = endpoint?.id;
  const load = useCallback(async () => {
    if (!id) return;
    try {
      setCaptures(await api.captures(id, filter || undefined));
      setListen('listening');
    } catch {
      setListen('offline');
    }
    setNow(Date.now());
  }, [api, id, filter]);

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

  if (failed) return <Notice title="Could not open the tester">{failed}</Notice>;
  if (!endpoint) return <Notice title="Opening your sandbox">One moment.</Notice>;
  return (
    <>
      <div className="wh-bar">
        <label className="wh-select">
          <Inbox aria-hidden="true" />
          <span className="sr">Endpoint</span>
          <select
            value={endpoint.id}
            onChange={(e) => setEndpoint(all.find((x) => x.id === e.target.value) ?? endpoint)}
          >
            {all.map((e) => (
              <option key={e.id} value={e.id}>
                {e.description || 'Capture endpoint'}
              </option>
            ))}
          </select>
        </label>
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
          className="btn"
          disabled={busy}
          onClick={() =>
            void act(async () => (await api.sendTest(endpoint.id, sendType)).captureId)
          }
        >
          <Send aria-hidden="true" />
          Send test event
        </button>
      </div>
      {message ? (
        <p className="wh-msg" role="alert">
          {message}
        </p>
      ) : null}
      <div className="wh-grid">
        <div className="stack g4">
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
          <div className="card card-b stack g2">
            <div className="xs muted">Forward to your machine</div>
            <div className="cmd">
              <span className="p">$</span>
              <code>{CLI}</code>
              <button
                type="button"
                className="iconbtn copy push"
                data-copy
                aria-label="Copy command"
              >
                <Copy className="lucide" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
        <div className="stack g4">
          {selected ? (
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
          <Samples samples={VERIFY_SAMPLES} />
        </div>
      </div>
    </>
  );
}

export function Tester({
  connect,
  types,
}: {
  connect: () => Promise<TesterAuth>;
  types: readonly string[];
}) {
  const [auth, setAuth] = useState<TesterAuth | 'loading' | 'error'>('loading');
  const [pending, setPending] = useState(connect);
  useEffect(() => {
    let live = true;
    setAuth('loading');
    pending.then(
      (a) => live && setAuth(a),
      () => live && setAuth('error'),
    );
    return () => {
      live = false;
    };
  }, [pending]);

  if (auth === 'loading') return <Notice title="Opening your sandbox">One moment.</Notice>;
  if (auth === 'error')
    return (
      <Notice title="Could not open the tester">
        <button type="button" className="btn outline sm" onClick={() => setPending(connect())}>
          Try again
        </button>
      </Notice>
    );
  if (auth.kind === 'signed-out')
    return (
      <Notice title="Sign in to capture webhooks">
        <a className="btn" href={SIGN_IN}>
          Sign in
        </a>
      </Notice>
    );
  if (auth.kind === 'no-sandbox')
    return (
      <Notice title="Make your sandbox first">
        <a className="btn" href="/developers/quickstart">
          Open the quickstart
        </a>
      </Notice>
    );
  return <Workspace api={auth.api} types={types} />;
}
