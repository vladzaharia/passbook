import type { BroadcastDto } from '@/shared/contracts/broadcasts.ts';
import { cn } from '../../lib/cn.ts';
import { formatCount } from '../../lib/format.ts';
import { progressOf } from './labels.ts';

/** Passes handled against passes targeted. The fill scales on X, so only a transform animates. */
export function BroadcastProgress({
  broadcast,
  className,
}: {
  broadcast: BroadcastDto;
  className?: string;
}) {
  const { done, total, ratio } = progressOf(broadcast);
  const failing = broadcast.counts.failed > 0;
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <div
        role="progressbar"
        aria-label="Passes handled"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-valuetext={`${formatCount(done)} of ${formatCount(total)} passes`}
        className="h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken"
      >
        <div
          className={cn(
            'h-full origin-left rounded-full transition-transform duration-500 ease-out motion-reduce:transition-none',
            failing ? 'bg-warning' : 'bg-accent',
          )}
          style={{ transform: `scaleX(${ratio})` }}
        />
      </div>
      <span className="text-xs tabular-nums text-fg-muted">
        {formatCount(done)} of {formatCount(total)}
      </span>
    </div>
  );
}
