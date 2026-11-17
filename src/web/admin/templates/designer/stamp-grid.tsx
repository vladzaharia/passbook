import { stampGrid } from '@/passkit/stamps/layout.ts';
import { cn } from '../../../lib/cn.ts';
import { gridNote } from './stamps.ts';
import './stamp-grid.css';

/** The strip's discs as the compositor lays them out, filled up to `count`; the reward is last. */
export function StampGrid({
  goal,
  count,
  className,
}: {
  goal: number;
  count: number;
  className?: string;
}) {
  const { cells } = stampGrid(goal);
  return (
    <svg
      viewBox="0 0 375 144"
      role="img"
      aria-label={`${gridNote(goal)}; ${Math.min(count, goal)} of ${goal} filled`}
      className={cn(
        'wl-stamp-grid w-full rounded-md border border-border bg-surface-sunken',
        className,
      )}
    >
      {cells.map((c) => (
        <circle
          key={c.index}
          cx={c.cx}
          cy={c.cy}
          r={c.d / 2}
          data-on={c.index < count || undefined}
          data-reward={c.reward || undefined}
        />
      ))}
    </svg>
  );
}
