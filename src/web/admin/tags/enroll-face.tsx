import { TAG_COPY, TAG_ERROR_COPY } from '@/shared/copy/tags.ts';
import { Callout, StepList, useNow } from '@/web/ui/index.ts';
import { formatCountdown } from '../scanning/scanners/labels.ts';
import type { Enrollment } from './enroll-api.ts';
import { EnrollArt } from './enroll-art.tsx';
import { fill } from './words.ts';

const D = TAG_COPY.dialog;
/** After this long without the scanner showing the request, say it may be busy. */
const SLOW_MS = 5000;

/** The request cannot go on: the pass changed hands or no longer works. */
const CLOSING = new Set<string>([
  'TAG_HOLDER_CHANGED',
  'TAG_PASS_VOIDED',
  'TAG_PASS_REMOVED',
  'TAG_PASS_EXPIRED',
]);

export type EndKind = 'again' | 'back' | 'close';

/** What an ended request says, and which footer follows: Send again, Back, or Close. */
export function endedOutcome(
  e: Enrollment,
  scanner: string,
): { tone: 'warning' | 'danger'; title: string; sub?: string; kind: EndKind } | null {
  const v = { scanner };
  switch (e.state) {
    case 'pending':
    case 'done':
      return null;
    case 'cancelled':
    case 'declined':
      return { tone: 'warning', title: fill(D.cancelledThere, v), kind: 'again' };
    case 'expired':
      return {
        tone: 'warning',
        title: fill(D.timeout.headline, v),
        sub: D.timeout.sub,
        kind: 'again',
      };
    case 'failed':
      if (e.errorCode === 'SCANNER_OFFLINE')
        return { tone: 'warning', title: fill(D.offline, v), kind: 'back' };
      if (e.errorCode && CLOSING.has(e.errorCode))
        return { tone: 'danger', title: TAG_ERROR_COPY[e.errorCode], kind: 'close' };
      return { tone: 'danger', title: fill(D.gone, v), kind: 'back' };
  }
}

function Steps({ current }: { current: 0 | 1 | 2 }) {
  return (
    <div className="mx-auto">
      <StepList
        label="Request progress"
        size="sm"
        items={D.steps.map((label, i) => ({
          id: label,
          label,
          state:
            i < current || (i === current && current === 2)
              ? 'done'
              : i === current
                ? 'working'
                : 'todo',
        }))}
      />
    </div>
  );
}

/** A ring that drains over the request's life: state, so it moves under reduced motion too. */
function Ring({ left, total }: { left: number; total: number }) {
  const r = 9;
  const c = 2 * Math.PI * r;
  const part = Math.min(1, Math.max(0, left / Math.max(1, total)));
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="wl-enroll-ring wl-essential size-5 -rotate-90">
      <circle cx="12" cy="12" r={r} fill="none" stroke="var(--color-border)" strokeWidth="2.5" />
      <circle
        cx="12"
        cy="12"
        r={r}
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - part)}
      />
    </svg>
  );
}

/** Waiting for the tap: the art, the ask, the steps and the countdown. */
export function WaitingFace({
  enrollment,
  scanner,
  ios,
  summary,
}: {
  enrollment: Enrollment;
  scanner: string;
  ios: boolean;
  /** "Works with all of Maya's passes", repeated so the choice stays in view. */
  summary: string;
}) {
  const now = useNow(1000);
  const left = enrollment.expiresAt - now;
  const shown = enrollment.shownAt !== null;
  const step = shown ? 1 : 0;
  const slow = !shown && now - enrollment.createdAt > SLOW_MS;
  const tagError = enrollment.errorCode ? TAG_ERROR_COPY[enrollment.errorCode] : null;
  const label = D.steps[step];
  return (
    <div className="wl-enroll-face flex flex-col gap-4 text-center">
      <EnrollArt stage="waiting" />
      <div className="flex flex-col gap-1">
        <p className="text-base font-medium text-fg-strong">
          {fill(ios ? D.waitIos : D.wait, { scanner })}
        </p>
        <p className="text-sm text-fg-muted">{summary}</p>
      </div>
      {tagError ? (
        <Callout tone="warning" className="text-left">
          {tagError}
        </Callout>
      ) : null}
      <Steps current={tagError ? 1 : step} />
      <p role="status" className="sr-only">
        {label}
      </p>
      {slow ? <p className="text-sm text-fg-muted">{fill(D.slow, { scanner })}</p> : null}
      <p className="flex items-center justify-center gap-2 text-sm text-fg-muted">
        <Ring left={left} total={enrollment.expiresAt - enrollment.createdAt} />
        <span aria-live="off">{fill(D.expires, { time: formatCountdown(Math.max(0, left)) })}</span>
      </p>
      <p role="status" className="sr-only">
        {left <= 0 ? 'Expired' : left <= 30_000 ? '30 seconds left' : ''}
      </p>
    </div>
  );
}
