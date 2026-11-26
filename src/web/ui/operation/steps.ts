import { createElement } from 'react';
import type { StepListItem } from '../step-marker.tsx';
import { countText, MARKER, stepMeta } from './text.ts';
import type { Operation } from './types.ts';

/** The StepList rows for an operation: the marker, count or wait on the right, the failure under its step. */
export function stepItems(op: Operation, now: number, zone?: string): StepListItem[] {
  return op.steps.map((s, i) => {
    // A wait the operation is not blocked on (the erase after Done) reads "By Dec 2".
    const tail = s.state === 'waiting' && s.waitingReason === 'due';
    const prev = op.steps[i - 1];
    return {
      id: s.key,
      label: s.label,
      state: MARKER[s.state],
      meta: stepMeta(s, now, zone, tail),
      group: s.group && s.group !== (prev?.group ?? null) ? s.group : undefined,
      detail:
        s.state === 'failed' && op.error
          ? createElement('span', { className: 'text-danger' }, op.error.message)
          : (s.detail ?? undefined),
    };
  });
}

/**
 * What the polite live region says: a step starting, a wait, the end. Never a count, so a step
 * that ticks from 4 of 12 to 5 of 12 stays silent.
 */
export function announcement(op: Operation): string {
  switch (op.status) {
    case 'queued':
      return 'Starting';
    case 'succeeded':
      return op.text;
    case 'failed':
      return `${op.text}. ${op.error?.message ?? ''}`.trim();
    case 'cancelled':
      return 'Stopped';
    default: {
      const step = op.steps.find((s) => s.key === op.step);
      const count = step ? countText(step) : null;
      return count && op.text.endsWith(` · ${count}`)
        ? op.text.slice(0, -(count.length + 3))
        : op.text;
    }
  }
}

/** Changes when the announcement should: a new step, a new status, a new attempt. */
export const announceKey = (op: Operation): string => `${op.status}|${op.step}|${op.attempt}`;
