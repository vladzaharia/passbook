import { Plus } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import type { WebhookEndpointDto } from '../../../shared/contracts/webhooks.ts';
import { WEBHOOKS_COPY } from '../../../shared/copy/developers-webhooks.ts';
import { StepUp } from '../ui/step-up.tsx';
import { stepUpOf } from './client.ts';

/** The host and path shape the API returns; the path is a bearer secret, so only the masked form is shown. */
const labelOf = (e: WebhookEndpointDto) =>
  e.target === 'capture' ? 'Capture endpoint' : e.description || e.urlMasked;

const subOf = (e: WebhookEndpointDto) =>
  e.target === 'capture'
    ? 'Built in. Signed, never sent'
    : e.status === 'active'
      ? `${e.eventTypes.length} events`
      : e.status === 'paused'
        ? 'Paused'
        : 'Disabled';

export function Endpoints({
  list,
  selected,
  onSelect,
}: {
  list: WebhookEndpointDto[];
  selected: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="card">
      <div className="card-h">
        <h2 className="h3">Endpoints</h2>
      </div>
      <ul className="wh-evs">
        {list.map((e) => (
          <li key={e.id}>
            <button
              type="button"
              className="wh-ev wh-ep"
              aria-pressed={e.id === selected}
              onClick={() => onSelect(e.id)}
            >
              <span
                className={`wh-code ${e.lastStatus === null ? '' : e.lastStatus < 300 ? 'ok-t' : 'bad-t'}`}
              >
                {e.lastStatus ?? '-'}
              </span>
              <span className="wh-t">{labelOf(e)}</span>
              <span className="wh-meta">{subOf(e)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

const NEXT = '/developers/webhooks';

/** One URL, https only. The secret comes back once and goes to the reveal sheet, not into this form. */
export function AddEndpoint({
  onCreate,
  onClose,
}: {
  onCreate: (url: string) => Promise<void>;
  onClose: () => void;
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
      else setError(err instanceof Error ? err.message : 'Could not add the endpoint.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card card-b stack g2" onSubmit={(e) => void submit(e)}>
      <h2 className="h3">Add endpoint</h2>
      <label className="stack g1">
        <span className="sm strong">URL</span>
        <input
          className="wh-input mono"
          type="url"
          required
          placeholder="https://hooks.example.dev/passbook"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          autoComplete="off"
        />
        <span className="xs muted">https only. The signing secret shows once.</span>
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
          Add
        </button>
        <button type="button" className="btn ghost sm" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Rotate the signing secret of a URL endpoint, after one confirm; the old one keeps signing for a day. */
export function RotateSecret({ rotate }: { rotate: () => Promise<void> }) {
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
        else setError(e instanceof Error ? e.message : 'Could not rotate.');
        setAsking(false);
      })
      .finally(() => setBusy(false));
  }

  return (
    <div className="card card-b stack g2">
      <div className="row g2">
        <h2 className="h3">Signing secret</h2>
        {asking ? null : (
          <button
            type="button"
            className="btn outline sm push"
            disabled={busy}
            onClick={() => setAsking(true)}
          >
            Rotate
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
        <span className="xs muted">The old secret keeps signing for 24 hours.</span>
      )}
      {stepUp !== null ? <StepUp signInUrl={stepUp} next={NEXT} /> : null}
      {error ? (
        <p className="wh-msg" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
