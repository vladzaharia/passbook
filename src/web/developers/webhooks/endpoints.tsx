import { Plus } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import type { WebhookEndpointDto } from '../../../shared/contracts/webhooks.ts';
import { BENCH_WEBHOOKS_COPY } from '../../../shared/copy/developers-bench-webhooks.ts';
import { WEBHOOKS_COPY } from '../../../shared/copy/developers-webhooks.ts';
import { StatusChip } from '../bench/status-chip.tsx';
import { Sheet } from '../ui/sheet.tsx';
import { StepUp } from '../ui/step-up.tsx';
import { stepUpOf } from './client.ts';
import { endpointLabel } from './model.ts';

const C = BENCH_WEBHOOKS_COPY.manage;
const NEXT = '/developers/webhooks';

const subOf = (e: WebhookEndpointDto) =>
  e.target === 'capture'
    ? BENCH_WEBHOOKS_COPY.capture.sub
    : e.status === 'active'
      ? C.events(e.eventTypes.length)
      : e.status === 'paused'
        ? C.paused
        : C.disabled;

/** One URL, https only. The secret comes back once and goes to the reveal sheet, not into this form. */
function AddEndpoint({
  onCreate,
  onCancel,
}: {
  onCreate: (url: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setStepUp(null);
    try {
      await onCreate(url.trim());
    } catch (err) {
      const asked = stepUpOf(err);
      if (asked !== null) setStepUp(asked);
      else setError(err instanceof Error ? err.message : BENCH_WEBHOOKS_COPY.errors.add);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="wh-form" onSubmit={(e) => void submit(e)}>
      <label className="wh-field-l">
        <span className="sm strong">{C.url}</span>
        <input
          className="wh-input mono"
          type="url"
          required
          placeholder={C.urlPlaceholder}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          autoComplete="off"
        />
        <span className="xs muted">{C.urlHint}</span>
      </label>
      {stepUp !== null ? <StepUp signInUrl={stepUp} next={NEXT} /> : null}
      {error ? (
        <p className="wh-msg" role="alert">
          {error}
        </p>
      ) : null}
      <div className="row g2">
        <button type="submit" className="btn sm" disabled={busy || !url.trim()}>
          <Plus aria-hidden="true" />
          {C.submit}
        </button>
        <button type="button" className="btn ghost sm" onClick={onCancel}>
          {C.cancel}
        </button>
      </div>
    </form>
  );
}

/** Rotate the signing secret of a URL endpoint, after one confirm; the old one keeps signing for a day. */
function RotateSecret({ rotate }: { rotate: () => Promise<void> }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState<string | null>(null);
  const c = WEBHOOKS_COPY.rotate;

  function run() {
    setBusy(true);
    setError(null);
    setStepUp(null);
    rotate()
      .then(() => setAsking(false))
      .catch((e: unknown) => {
        const asked = stepUpOf(e);
        if (asked !== null) setStepUp(asked);
        else setError(e instanceof Error ? e.message : BENCH_WEBHOOKS_COPY.errors.rotate);
        setAsking(false);
      })
      .finally(() => setBusy(false));
  }

  return (
    <section className="wh-sec" aria-label={C.secret}>
      <div className="row g2">
        <h3 className="wh-h">{C.secret}</h3>
        {asking ? null : (
          <button
            type="button"
            className="btn outline sm push"
            disabled={busy}
            onClick={() => setAsking(true)}
          >
            {c.confirm}
          </button>
        )}
      </div>
      {asking ? (
        <div className="stack g2">
          <span className="sm">{c.ask}</span>
          <div className="row g2">
            <button type="button" className="btn sm" disabled={busy} onClick={run}>
              {c.confirm}
            </button>
            <button type="button" className="btn ghost sm" onClick={() => setAsking(false)}>
              {c.cancel}
            </button>
          </div>
        </div>
      ) : (
        <span className="xs muted">{C.rotateNote}</span>
      )}
      {stepUp !== null ? <StepUp signInUrl={stepUp} next={NEXT} /> : null}
      {error ? (
        <p className="wh-msg" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/**
 * The endpoints of the sandbox: the built-in capture endpoint and each URL one. Pick one to list
 * its deliveries, add a URL, or rotate the signing secret of the one showing.
 */
export function ManageSheet({
  endpoints,
  current,
  onPick,
  onClose,
  onCreate,
  onRotate,
}: {
  endpoints: readonly WebhookEndpointDto[];
  current: WebhookEndpointDto;
  onPick: (id: string) => void;
  onClose: () => void;
  onCreate: (url: string) => Promise<void>;
  onRotate: () => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <Sheet title={C.title} onClose={onClose}>
      <ul className="wh-eps">
        {endpoints.map((e) => (
          <li key={e.id}>
            <button
              type="button"
              className="wh-ep"
              aria-pressed={e.id === current.id}
              onClick={() => onPick(e.id)}
            >
              <span className="wh-ep-t">{endpointLabel(e)}</span>
              <span className="wh-ep-s">{subOf(e)}</span>
              <StatusChip status={e.lastStatus} tone={e.lastStatus ? undefined : 'neutral'}>
                {e.lastStatus ?? '·'}
              </StatusChip>
            </button>
          </li>
        ))}
      </ul>
      {adding ? (
        <AddEndpoint onCreate={onCreate} onCancel={() => setAdding(false)} />
      ) : (
        <button type="button" className="btn outline wh-add" onClick={() => setAdding(true)}>
          <Plus aria-hidden="true" />
          {C.add}
        </button>
      )}
      {current.target === 'url' ? <RotateSecret key={current.id} rotate={onRotate} /> : null}
    </Sheet>
  );
}
