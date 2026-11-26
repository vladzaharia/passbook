import { cn } from '../../lib/cn.ts';
import { formatClock } from '../../lib/format.ts';
import { OPERATION_STATUS } from '../../lib/status-operations.ts';
import { elapsedMs } from './text.ts';
import type { Operation } from './types.ts';

const TONE = {
  neutral: 'text-fg-muted',
  info: 'text-info',
  success: 'text-success',
  danger: 'text-danger',
} as const;

/**
 * The compact row: status glyph, title, the current line, a 2 px bar when the step counts, and
 * elapsed time. A button when `onOpen` is given. Used by the tray and by flows that keep a row in
 * place of the panel (the scanner's offline status).
 */
export function OperationRow({
  operation: op,
  now,
  onOpen,
  className,
}: {
  operation: Operation;
  now: number;
  onOpen?: (op: Operation) => void;
  className?: string;
}) {
  const entry = OPERATION_STATUS[op.status];
  const Icon = entry.icon;
  const step = op.steps.find((s) => s.key === op.step);
  const share = step?.total ? Math.min(1, (step.done ?? 0) / step.total) : null;
  const line =
    op.status === 'succeeded'
      ? (op.doneTitle ?? op.title)
      : op.status === 'failed'
        ? (op.failTitle ?? 'Could not finish')
        : op.status === 'cancelled'
          ? 'Stopped'
          : op.text;
  const body = (
    <>
      <Icon
        aria-hidden
        className={cn(
          'mt-0.5 size-4 shrink-0',
          TONE[
            entry.tone === 'info' || entry.tone === 'success' || entry.tone === 'danger'
              ? entry.tone
              : 'neutral'
          ],
          'spin' in entry && entry.spin && 'wl-spin wl-essential',
        )}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline justify-between gap-3">
          <span className="truncate text-sm font-medium text-fg-strong">{op.title}</span>
          <span className="sr-only">{entry.label}</span>
          <span aria-hidden className="shrink-0 font-mono text-xs tabular-nums text-fg-muted">
            {formatClock(elapsedMs(op, now))}
          </span>
        </span>
        <span className="truncate text-xs text-fg-muted">{line}</span>
        {share !== null && op.status === 'running' ? (
          <span
            aria-hidden
            className="mt-1 block h-0.5 overflow-hidden rounded-full bg-surface-sunken"
          >
            <span
              className="block h-full origin-left rounded-full bg-accent motion-safe:transition-transform motion-safe:duration-(--wl-dur-enter) motion-safe:ease-(--wl-ease-move)"
              style={{ transform: `scaleX(${share})` }}
            />
          </span>
        ) : null}
      </span>
    </>
  );
  const base =
    'flex w-full items-start gap-3 rounded-md px-3 py-2.5 text-left pointer-coarse:min-h-14';
  return onOpen ? (
    <button
      type="button"
      onClick={() => onOpen(op)}
      className={cn(
        base,
        'wl-colors hover:bg-state-hover-tint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        className,
      )}
    >
      {body}
    </button>
  ) : (
    <div className={cn(base, className)}>{body}</div>
  );
}
