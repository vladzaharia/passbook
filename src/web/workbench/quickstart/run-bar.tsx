import { Copy, Play, RotateCw } from 'lucide-react';
import { useState } from 'react';
import { QS_COPY } from '../../../shared/copy/developers-quickstart.ts';
import { copyToClipboard } from '../playground/copy.ts';
import { stamp } from './model.ts';
import type { Call } from './types.ts';
import { useSlow } from './use-clock.ts';

const short = (id: string) => (id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id);

/** Run, what happened and Run again, in one bar under the code. The status is words and a stamp, not colour alone. */
export function RunBar({
  call,
  sending,
  runLabel,
  againLabel,
  disabled,
  onRun,
  replayNote,
}: {
  call: Call;
  sending: string;
  runLabel: string;
  againLabel: string;
  disabled: boolean;
  onRun: () => void;
  replayNote?: string;
}) {
  const slow = useSlow(call.state === 'running');
  const [copied, setCopied] = useState(false);
  const id = call.state === 'ok' ? call.requestId : call.state === 'fail' ? call.requestId : null;
  const copyId = async () => {
    if (id && (await copyToClipboard(id))) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  };
  return (
    <div className="runbar qs-runbar" data-state={call.state}>
      <div className="qs-run-left" role="status" aria-live="polite">
        {call.state === 'running' ? (
          <span className="row g2 muted sm">
            <span className="spin" aria-hidden="true" />
            {sending}
          </span>
        ) : null}
        {call.state === 'ok' ? (
          <span className="row g3 wrap-row">
            <span className="stamp ok">{stamp(call.status)}</span>
            {call.etag ? <span className="mono xs muted">ETag {call.etag}</span> : null}
            <span className="mono xs muted">{call.ms} ms</span>
            {id ? (
              <span className="mono xs muted row g1">
                req {short(id)}
                <button
                  type="button"
                  className="iconbtn qs-mini"
                  aria-label={copied ? 'Copied' : 'Copy request id'}
                  onClick={() => void copyId()}
                >
                  <Copy aria-hidden="true" className="lucide" />
                </button>
              </span>
            ) : null}
            {call.replayed && replayNote ? <span className="xs muted">{replayNote}</span> : null}
          </span>
        ) : null}
        {call.state === 'fail' ? (
          <span className="row g3 wrap-row">
            <span className="stamp bad">{stamp(call.problem.status)}</span>
            {call.problem.code ? <span className="mono xs muted">{call.problem.code}</span> : null}
          </span>
        ) : null}
        {call.state === 'idle' ? (
          <span className="xs muted mono">{sending.replace('Sending ', '')}</span>
        ) : null}
        {slow ? (
          <p className="xs qs-slow" role="note">
            {QS_COPY.steps.run.slow}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        className={call.state === 'ok' ? 'btn outline' : 'btn run'}
        disabled={disabled || (call.state === 'running' && !slow)}
        aria-busy={call.state === 'running'}
        onClick={onRun}
      >
        {call.state === 'ok' ? <RotateCw aria-hidden="true" /> : <Play aria-hidden="true" />}
        {call.state === 'ok' ? againLabel : runLabel}
      </button>
    </div>
  );
}
