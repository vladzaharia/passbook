import { useEffect, useRef } from 'react';
import type { z } from 'zod';
import type { TestConnectionResponseSchema } from '@/shared/contracts/connections.ts';
import { cn } from '../../lib/cn.ts';
import { errorMessage as apiErrorMessage } from '../../lib/errors.ts';
import { StatusPill } from '../../ui/index.ts';
import { errorMessage } from './labels.ts';
import './connections.css';

export type TestOutcome =
  | { kind: 'result'; result: z.infer<typeof TestConnectionResponseSchema>; at: number }
  | { kind: 'error'; error: unknown; at: number };

/** One line for a test: what passed, or what failed and what to do. */
export function testLine(outcome: TestOutcome): string {
  if (outcome.kind === 'error') return apiErrorMessage(outcome.error);
  const r = outcome.result;
  if (r.ok) return `${r.detail ?? 'Reachable.'} ${r.durationMs} ms.`.trim();
  return errorMessage(r.errorCode) ?? 'The test failed.';
}

/**
 * The test result pill in a reserved slot (the row keeps its height): a pass pops, a failure shakes
 * once; the sentence sits next to it with the code in mono.
 */
export function TestResult({ outcome, className }: { outcome?: TestOutcome; className?: string }) {
  const pill = useRef<HTMLSpanElement>(null);
  const ok = outcome?.kind === 'result' && outcome.result.ok;
  const code =
    outcome?.kind === 'result' && !outcome.result.ok ? outcome.result.errorCode : undefined;
  useEffect(() => {
    const el = pill.current;
    if (!outcome || !el) return;
    el.removeAttribute('data-result');
    void el.offsetWidth;
    el.setAttribute('data-result', ok ? 'ok' : 'fail');
  }, [outcome, ok]);
  return (
    <span
      role="status"
      className={cn('inline-flex min-h-6 min-w-0 items-center gap-2 text-sm', className)}
    >
      {outcome ? (
        <>
          <span ref={pill} className="wl-result inline-flex shrink-0">
            <StatusPill status={ok ? 'verified' : 'failing'}>
              {ok ? 'Test passed' : 'Test failed'}
            </StatusPill>
          </span>
          <span className="min-w-0 truncate text-fg-muted" title={testLine(outcome)}>
            {testLine(outcome)}
          </span>
          {code ? <span className="shrink-0 font-mono text-xs text-fg-muted">{code}</span> : null}
        </>
      ) : null}
    </span>
  );
}
