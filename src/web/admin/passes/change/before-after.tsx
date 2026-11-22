import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import type { z } from 'zod';
import type { ChangeRunPreviewSchema } from '@/shared/contracts/broadcasts-change.ts';
import { cn } from '../../../lib/cn.ts';
import { IconButton, SegmentedControl, Skeleton } from '../../../ui/index.ts';
import './change.css';

type Preview = z.infer<typeof ChangeRunPreviewSchema>;

/**
 * The stage: a real sample pass, before and after, cycling through the server's samples. The fields
 * that change are outlined (two pulses); nothing here is saved.
 */
export function BeforeAfter({
  preview,
  empty,
  waiting,
}: {
  preview: Preview | undefined;
  empty: string;
  /** A preview is on its way: show the placeholder, not the empty line. */
  waiting: boolean;
}) {
  const [side, setSide] = useState<'before' | 'after'>('after');
  const [index, setIndex] = useState(0);
  const samples = preview?.samples ?? [];
  const at = samples.length ? index % samples.length : 0;
  const sample = samples[at];
  if (!preview)
    return waiting ? (
      <Skeleton className="h-64" />
    ) : (
      <p className="text-sm text-fg-muted">{empty}</p>
    );
  if (!sample) return <p className="text-sm text-fg-muted">{empty}</p>;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <SegmentedControl
          label="Show"
          options={[
            { value: 'before', label: 'Before' },
            { value: 'after', label: 'After' },
          ]}
          value={side}
          onValueChange={setSide}
        />
        <div className="flex items-center gap-1">
          <IconButton
            label="Previous pass"
            icon={<ChevronLeft aria-hidden />}
            disabled={samples.length < 2}
            onClick={() => setIndex(at - 1 < 0 ? samples.length - 1 : at - 1)}
          />
          <span className="text-xs tabular-nums text-fg-muted">
            {at + 1} of {samples.length}
          </span>
          <IconButton
            label="Next pass"
            icon={<ChevronRight aria-hidden />}
            disabled={samples.length < 2}
            onClick={() => setIndex((at + 1) % samples.length)}
          />
        </div>
      </div>
      <div
        key={sample.passId}
        className="wl-sheen wl-deal overflow-hidden rounded-2xl border border-border bg-surface-raised p-4 shadow-elevation-2"
      >
        <p className="truncate text-base font-semibold text-fg-strong">
          {sample.title ?? 'Untitled pass'}
        </p>
        <dl className="mt-3 grid gap-2">
          {sample.changes.map((c) => (
            <div
              key={`${c.key}-${side}`}
              className={cn(
                'wl-changed wl-stage-swap px-2 py-1.5',
                side === 'before' && 'opacity-80',
              )}
            >
              <dt className="text-xs text-fg-muted">{c.label}</dt>
              <dd className="break-words text-sm font-medium text-fg-strong">
                {(side === 'before' ? c.from : c.to) ?? 'Empty'}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
