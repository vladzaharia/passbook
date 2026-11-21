import { Plus } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import type { WebhookEndpointDto } from '../../../shared/contracts/webhooks.ts';

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

/** One URL, https only. The signing secret is returned once, so it is shown once. */
export function AddEndpoint({
  onCreate,
  onClose,
}: {
  onCreate: (url: string) => Promise<string>;
  onClose: () => void;
}) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setSecret(await onCreate(url.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the endpoint.');
    } finally {
      setBusy(false);
    }
  }

  if (secret)
    return (
      <div className="card card-b stack g2" role="status">
        <div className="row">
          <h2 className="h3">Signing secret</h2>
          <span className="pill info push">Shown once</span>
        </div>
        <div className="cmd">
          <code>{secret}</code>
          <button
            type="button"
            className="iconbtn copy push"
            data-copy
            data-copy-text={secret}
            aria-label="Copy secret"
          >
            Copy
          </button>
        </div>
        <button type="button" className="btn outline sm" onClick={onClose}>
          Done
        </button>
      </div>
    );
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
