import { RotateCw, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import type { WebhookCaptureDto } from '../../../shared/contracts/webhook-captures.ts';
import { curlOf, evtShort, prettyBody } from './format.ts';
import { VerifyPanel } from './verify.tsx';

type Tab = 'headers' | 'body' | 'attempts' | 'verify';
const TABS: { id: Tab; label: string }[] = [
  { id: 'headers', label: 'Headers' },
  { id: 'body', label: 'Body' },
  { id: 'attempts', label: 'Attempts' },
  { id: 'verify', label: 'Verify' },
];

function Pre({ text, label }: { text: string; label: string }) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable text region
    <section className="wh-pre" tabIndex={0} aria-label={label}>
      <pre>{text}</pre>
    </section>
  );
}

export function Detail({
  capture,
  busy,
  onReplay,
  loadSecret,
}: {
  capture: WebhookCaptureDto;
  busy: boolean;
  onReplay: () => void;
  loadSecret: () => Promise<string>;
}) {
  const [tab, setTab] = useState<Tab>('verify');
  return (
    <div className="card">
      <div className="card-h">
        <h2 className="wh-title">{capture.type}</h2>
        <span className="mono xs muted wh-hide-s">evt {evtShort(capture.eventId)}</span>
        <button type="button" className="btn ghost sm push" disabled={busy} onClick={onReplay}>
          <RotateCw aria-hidden="true" />
          Replay
        </button>
        <button
          type="button"
          className="btn ghost sm wh-hide-s"
          data-copy
          data-copy-text={curlOf(capture)}
        >
          Copy as curl
        </button>
      </div>
      <div className="wh-tabs" role="tablist" aria-label="Capture">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`wh-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="wh-panel"
            onClick={() => setTab(t.id)}
          >
            {t.id === 'verify' ? <ShieldCheck aria-hidden="true" /> : null}
            {t.label}
          </button>
        ))}
      </div>
      <div id="wh-panel" role="tabpanel" aria-labelledby={`wh-tab-${tab}`}>
        {tab === 'headers' ? (
          <Pre
            label="Request headers"
            text={Object.entries(capture.headers)
              .map(([k, v]) => `${k}: ${v}`)
              .join('\n')}
          />
        ) : null}
        {tab === 'body' ? <Pre label="Request body" text={prettyBody(capture.body)} /> : null}
        {tab === 'attempts' ? (
          <div className="card-b stack g2">
            <span className="mono sm">
              {capture.status} · {capture.durationMs} ms · {capture.trigger}
            </span>
            <span className="sm muted">Stored, not sent. Nothing left PassBook.</span>
          </div>
        ) : null}
        {tab === 'verify' ? (
          <VerifyPanel key={capture.id} capture={capture} loadSecret={loadSecret} />
        ) : null}
      </div>
    </div>
  );
}
