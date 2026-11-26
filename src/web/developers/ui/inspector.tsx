import { Copy, Repeat } from 'lucide-react';
import { useState } from 'react';
import { RUN_LIMIT, remaining as runsLeft } from '../console/budget.ts';
import { COPY_LANGS, copyAs, type Sent } from '../console/copy-as.ts';
import type { Outcome } from '../console/send.ts';
import { copyToClipboard as copyText } from '../shell/copy.ts';
import { CopyAsMenu } from './copy-as-menu.tsx';
import { JsonTree } from './json-tree.tsx';
import { Stamp } from './stamp.tsx';
import { statusText } from './status-text.ts';

const header = (o: Outcome, name: string) => o.headers.find(([n]) => n === name)?.[1];
const short = (id: string) => (id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id);

interface Props {
  outcome: Outcome;
  sent: Sent;
  codes: ReadonlySet<string>;
  /** Sends the same request again with the same Idempotency-Key. */
  onReplay?: (() => void) | undefined;
}

/** The response: stamp, timing, request id, the headers that matter, the body as text, Copy as. */
export function Inspector({ outcome: o, sent, codes, onReplay }: Props) {
  const [copied, setCopied] = useState(false);
  const label = statusText(o.status, o.statusText);
  const remaining = header(o, 'ratelimit-remaining');
  const replay = header(o, 'idempotent-replayed');
  const facts: [string, string][] = [
    // The server sends RateLimit-Remaining on 429 only; otherwise the page's own count is the gauge.
    remaining ? ['RateLimit-Remaining', remaining] : ['Runs left', `${runsLeft()}/${RUN_LIMIT}`],
    ...(o.key
      ? ([['Idempotent-Replayed', replay === 'true' ? 'true' : 'false']] as [string, string][])
      : []),
    ...(header(o, 'etag') ? ([['ETag', header(o, 'etag') as string]] as [string, string][]) : []),
    ...(header(o, 'retry-after')
      ? ([['Retry-After', `${header(o, 'retry-after')} s`]] as [string, string][])
      : []),
  ];
  return (
    <div className="insp">
      <div className="insp-h">
        <Stamp status={label} tone={o.status < 400 ? 'ok' : 'bad'} />
        <span className="mono xs muted">{o.ms} ms</span>
        {o.requestId ? (
          <span className="mono xs muted insp-req">
            req {short(o.requestId)}
            <button
              type="button"
              className="iconbtn"
              aria-label="Copy request id"
              onClick={() => void copyText(o.requestId ?? '').then(setCopied)}
            >
              <Copy aria-hidden="true" />
            </button>
            {copied ? <span className="xs success-text">copied</span> : null}
          </span>
        ) : null}
        <span className="push" />
        <CopyAsMenu
          items={COPY_LANGS.map((l) => ({
            key: l.lang,
            label: l.label,
            text: () => copyAs(l.lang, sent),
          }))}
        />
      </div>
      <p className="sr" role="status" aria-live="polite">
        {label} in {o.ms} milliseconds.
        {replay === 'true' ? ' Replayed from the first call.' : ''}
      </p>
      <dl className="insp-facts">
        {facts.map(([k, v]) => (
          <div key={k} className={k === 'Idempotent-Replayed' && v === 'true' ? 'fact on' : 'fact'}>
            <dt className="mono">{k}</dt>
            <dd className="mono">{v}</dd>
          </div>
        ))}
      </dl>
      {o.key && o.status < 300 && onReplay ? (
        <button type="button" className="btn ghost sm insp-replay" onClick={onReplay}>
          <Repeat aria-hidden="true" />
          Run again with the same key
        </button>
      ) : null}
      {o.json !== undefined ? (
        <JsonTree value={o.json} codes={codes} />
      ) : (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region
        <section className="region" tabIndex={0} aria-label="Response body">
          <pre className="src">{o.text === '' ? 'No body.' : o.text}</pre>
        </section>
      )}
      {o.truncated ? <p className="xs muted insp-note">Showing the first 256 kB.</p> : null}
    </div>
  );
}
