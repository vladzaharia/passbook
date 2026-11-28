import { Send } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../../lib/cn.ts';
import { errorMessage } from '../../lib/errors.ts';
import type { BuddyScene } from '../art/index.ts';
import { Button } from '../button.tsx';
import { CopyRow } from './copy-row.tsx';
import { LivePanel } from './live-panel.tsx';
import { Troubleshoot } from './troubleshoot.tsx';
import { outboundTrouble } from './troubleshoot-copy.ts';
import type { SendResult } from './types.ts';

export interface SendProps {
  mode: 'send';
  /** Posts a test event (`POST /v1/webhooks/{id}/test`) and resolves with what the server answered. */
  send: () => Promise<SendResult>;
  /** The endpoint's host, drawn on the lane. */
  host: string;
  /** Without the permission the button is not drawn. */
  canSend?: boolean;
  /** Off where a step heading already says it: the title stays for screen readers only. */
  title?: boolean;
  onChange?: (state: {
    phase: 'idle' | 'sending' | 'delivered' | 'failed';
    result: SendResult | null;
  }) => void;
  buddy?: boolean;
  className?: string;
}

type Outcome =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'done'; result: SendResult; n: number }
  | { kind: 'error'; error: unknown; n: number };

/**
 * Send a test event. A pulse crosses from the buddy to the endpoint while the request is out; it
 * pops on a 2xx, or shakes with the buddy's apology (our side may be at fault: no head shake).
 */
export function SendCheck({
  send,
  host,
  canSend = true,
  title = true,
  onChange,
  buddy,
  className,
}: SendProps) {
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });
  const sending = outcome.kind === 'sending';
  const result = outcome.kind === 'done' ? outcome.result : null;
  const failed = outcome.kind === 'error' || (result !== null && !result.ok);
  const lane = sending
    ? 'sending'
    : result
      ? result.ok
        ? 'ok'
        : 'fail'
      : outcome.kind === 'error'
        ? 'fail'
        : 'idle';
  const trouble = result ? outboundTrouble(result) : null;

  async function press() {
    setOutcome({ kind: 'sending' });
    onChange?.({ phase: 'sending', result: null });
    const n = Date.now();
    try {
      const got = await send();
      setOutcome({ kind: 'done', result: got, n });
      onChange?.({ phase: got.ok ? 'delivered' : 'failed', result: got });
    } catch (error) {
      setOutcome({ kind: 'error', error, n });
      onChange?.({ phase: 'failed', result: null });
    }
  }
  const scene: BuddyScene = sending ? 'busy' : failed ? 'sorry' : result ? 'cheer' : 'beat';
  const say = sending
    ? 'Sending a test.'
    : outcome.kind === 'error'
      ? "Couldn't send the test."
      : trouble
        ? result?.ok
          ? 'Delivered.'
          : `Failed. ${trouble.title}.`
        : '';
  return (
    <LivePanel
      label="Send a test"
      scene={scene}
      mood={failed ? 'sad' : result ? 'happy' : 'curious'}
      buddy={buddy !== false}
      say={say}
      sayKey={`${outcome.kind}|${'n' in outcome ? outcome.n : ''}`}
      className={className}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          {title ? (
            <h4 className="text-base font-semibold text-fg-strong">Send a test</h4>
          ) : (
            <h3 className="sr-only">Send a test</h3>
          )}
        </div>
        {canSend ? (
          <Button
            variant={result?.ok ? 'outline' : 'primary'}
            busy="pulse"
            loading={sending}
            iconStart={<Send aria-hidden />}
            onClick={() => void press()}
          >
            {result || outcome.kind === 'error' ? 'Send again' : 'Send test'}
          </Button>
        ) : null}
      </div>
      <div className="ws-lane flex items-center gap-3" data-state={lane}>
        <div aria-hidden className="relative h-5 min-w-0 flex-1">
          <span className="absolute inset-x-0 top-1/2 border-t border-dashed border-border-strong" />
          <span
            data-state={lane}
            className="ws-dot absolute top-1/2 left-0 size-3 -translate-y-1/2 rounded-full bg-accent opacity-0 data-[state=ok]:hidden"
          />
        </div>
        <span
          data-state={lane}
          className={cn(
            'ws-chip max-w-[60%] shrink-0 truncate rounded-md border px-2 py-1 font-mono text-xs',
            lane === 'ok' && 'border-success-border bg-success-subtle text-success',
            lane === 'fail' && 'border-danger-border bg-danger-subtle text-danger',
            (lane === 'idle' || lane === 'sending') &&
              'border-border-strong bg-surface-sunken text-fg',
          )}
        >
          {host}
        </span>
      </div>
      {outcome.kind === 'error' ? (
        <p className="text-sm text-danger">{errorMessage(outcome.error)}</p>
      ) : trouble ? (
        <Troubleshoot trouble={trouble} />
      ) : null}
      {result && !result.ok && result.requestId ? (
        <CopyRow label="Request id" value={result.requestId} />
      ) : null}
    </LivePanel>
  );
}
