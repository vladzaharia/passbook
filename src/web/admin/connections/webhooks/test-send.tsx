import { Send } from 'lucide-react';
import { useState } from 'react';
import type { z } from 'zod';
import type { WebhookTestResultSchema } from '@/shared/contracts/webhooks.ts';
import { cn } from '../../../lib/cn.ts';
import { errorMessage } from '../../../lib/errors.ts';
import { Buddy, Button, StatusPill, toast } from '../../../ui/index.ts';
import { useEndpointActions } from './api.ts';
import { responseLabel } from '../../../ui/webhooks/labels.ts';
import './webhooks.css';

type Result = z.infer<typeof WebhookTestResultSchema>;
type Outcome =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'done'; result: Result; n: number }
  | { kind: 'error'; error: unknown; n: number };

/** "Delivered: 200 in 140 ms" or "Failed: HTTP 503". */
export function resultLine(r: Result): string {
  return r.ok
    ? `Delivered: ${r.status ?? 200} in ${r.durationMs} ms`
    : `Failed: ${responseLabel(r.status, r.errorCode) || 'no answer'}`;
}

/**
 * Send a test event. The buddy sits on the panel's edge; while the request is out a pulse crosses
 * to the endpoint, then it pops (delivered) or shakes with the buddy's apology (failed: our side
 * may be at fault, so no head shake).
 */
export function TestSend({
  endpointId,
  host,
  canManage,
  className,
}: {
  endpointId: string;
  host: string;
  canManage: boolean;
  className?: string;
}) {
  const { test } = useEndpointActions(endpointId);
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });
  const sending = outcome.kind === 'sending';
  const failed = outcome.kind === 'error' || (outcome.kind === 'done' && !outcome.result.ok);
  const state = sending
    ? 'sending'
    : outcome.kind === 'done'
      ? outcome.result.ok
        ? 'ok'
        : 'fail'
      : 'idle';

  async function send() {
    const n = Date.now();
    setOutcome({ kind: 'sending' });
    try {
      const result = await test.mutateAsync();
      setOutcome({ kind: 'done', result, n });
      if (result.ok) toast.success(resultLine(result));
      else toast.error('Check the endpoint.', resultLine(result));
    } catch (error) {
      setOutcome({ kind: 'error', error, n });
      toast.error(error, 'Could not send');
    }
  }

  return (
    <section
      aria-labelledby="test-send-title"
      className={cn(
        'relative mt-14 rounded-lg border border-border bg-surface-raised px-4 pt-6 pb-4',
        className,
      )}
    >
      <Buddy
        key={outcome.kind === 'idle' || sending ? 'rest' : `${outcome.kind}-${outcome.n}`}
        size="sm"
        at="start"
        mood={failed ? 'sad' : outcome.kind === 'done' ? 'happy' : 'curious'}
        scene={failed ? 'sorry' : outcome.kind === 'done' ? 'cheer' : 'beat'}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 id="test-send-title" className="text-sm font-medium text-fg-strong">
            Test event
          </h3>
        </div>
        {canManage ? (
          <Button
            variant="outline"
            busy="pulse"
            loading={sending}
            iconStart={<Send aria-hidden />}
            onClick={() => void send()}
          >
            Send test event
          </Button>
        ) : null}
      </div>
      <div className="wh-lane mt-4 flex items-center gap-3" data-state={state}>
        <div className="relative h-5 min-w-0 flex-1" aria-hidden>
          <span className="absolute inset-x-0 top-1/2 border-t border-dashed border-border-strong" />
          <span
            data-state={state}
            className="wh-dot absolute top-1/2 left-0 size-3 -translate-y-1/2 rounded-full bg-accent opacity-0 data-[state=ok]:hidden"
          />
        </div>
        <span
          data-state={state}
          className={cn(
            'wh-chip max-w-[60%] shrink-0 truncate rounded-md border px-2 py-1 font-mono text-xs',
            state === 'ok' && 'border-success-border bg-success-subtle text-success',
            state === 'fail' && 'border-danger-border bg-danger-subtle text-danger',
            (state === 'idle' || state === 'sending') &&
              'border-border-strong bg-surface-sunken text-fg',
          )}
        >
          {host}
        </span>
      </div>
      <p role="status" className="mt-3 flex min-h-6 flex-wrap items-center gap-2 text-sm">
        {sending ? (
          <span className="text-fg-muted">Sending…</span>
        ) : outcome.kind === 'done' ? (
          <>
            <StatusPill status={outcome.result.ok ? 'verified' : 'failed'}>
              {outcome.result.ok ? 'Delivered' : 'Failed'}
            </StatusPill>
            <span className="text-fg-muted">{resultLine(outcome.result)}</span>
          </>
        ) : outcome.kind === 'error' ? (
          <span className="text-danger">{errorMessage(outcome.error)}</span>
        ) : null}
      </p>
    </section>
  );
}
