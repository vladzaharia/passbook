import { Filter } from 'lucide-react';
import type { WebhookCaptureDto } from '../../../shared/contracts/webhook-captures.ts';
import { ago, metaOf } from './format.ts';

export type ListenState = 'listening' | 'paused' | 'offline';

const PILL: Record<ListenState, { cls: string; text: string }> = {
  listening: { cls: 'success', text: 'Listening' },
  paused: { cls: 'neutral', text: 'Paused' },
  offline: { cls: 'danger', text: 'Offline' },
};

export function Deliveries({
  captures,
  selected,
  onSelect,
  filter,
  onFilter,
  types,
  listen,
  now,
}: {
  captures: WebhookCaptureDto[];
  selected: string | null;
  onSelect: (id: string) => void;
  filter: string;
  onFilter: (type: string) => void;
  types: readonly string[];
  listen: ListenState;
  now: number;
}) {
  const pill = PILL[listen];
  return (
    <div className="card">
      <div className="card-h">
        <h2 className="h3">Deliveries</h2>
        <span className={`pill ${pill.cls}`} role="status">
          <span className={`wh-dot${listen === 'listening' ? ' live' : ''}`} aria-hidden="true" />
          {pill.text}
        </span>
        <label className="wh-filter">
          <Filter aria-hidden="true" />
          <span className="sr">Event type</span>
          <select value={filter} onChange={(e) => onFilter(e.target.value)}>
            <option value="">All types</option>
            {types.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
      </div>
      {captures.length === 0 ? (
        <p className="card-b muted sm" data-empty>
          {filter ? 'No captures of this type.' : 'Nothing captured yet. Send a test event.'}
        </p>
      ) : (
        <ul className="wh-evs">
          {captures.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="wh-ev"
                aria-pressed={c.id === selected}
                onClick={() => onSelect(c.id)}
              >
                <span className={`wh-code ${c.status < 300 ? 'ok-t' : 'bad-t'}`}>{c.status}</span>
                <span className="wh-t">{c.type}</span>
                <span className="wh-when">
                  {ago(c.createdAt, now)}
                  <br />
                  {c.durationMs} ms
                </span>
                <span className="wh-meta">{metaOf(c)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
