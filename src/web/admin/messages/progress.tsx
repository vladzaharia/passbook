import type { BroadcastDto } from '@/shared/contracts/broadcasts.ts';
import { cn } from '../../lib/cn.ts';
import { formatCount } from '../../lib/format.ts';
import { ProgressBar } from '../../ui/progress-bar.tsx';
import { progressOf } from './labels.ts';

/** Passes handled against passes targeted. The fill scales on X, so only a transform animates. */
export function BroadcastProgress({
  broadcast,
  className,
}: {
  broadcast: BroadcastDto;
  className?: string;
}) {
  const { done, total } = progressOf(broadcast);
  const failing = broadcast.counts.failed > 0;
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <ProgressBar
        label="Passes handled"
        value={done}
        max={total}
        valueText={`${formatCount(done)} of ${formatCount(total)} passes`}
        tone={failing ? 'warning' : 'accent'}
      />
      <span className="text-xs tabular-nums text-fg-muted">
        {formatCount(done)} of {formatCount(total)}
      </span>
    </div>
  );
}
