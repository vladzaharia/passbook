import type { ReactNode } from 'react';
import { cn } from '../lib/cn.ts';

export interface KeyValueItem {
  /** Stable key when labels can repeat (pass fields). */
  id?: string;
  label: string;
  value: ReactNode;
  mono?: boolean;
}

/**
 * Label (muted, normal weight) and value pairs. A container query stacks the label over the value
 * when the block is narrower than 22rem (cards in asides, 200% zoom).
 */
export function KeyValue({
  items,
  className,
}: {
  items: readonly KeyValueItem[];
  className?: string;
}) {
  return (
    <div className={cn('@container', className)}>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm @[22rem]:gap-y-2 @[22rem]:grid-cols-[minmax(7rem,max-content)_minmax(0,1fr)]">
        {items.map((item) => (
          // Stacked: 2 px within a pair, 12 px between pairs.
          <div key={item.id ?? item.label} className="flex flex-col gap-0.5 @[22rem]:contents">
            <dt className="font-normal text-fg-muted">{item.label}</dt>
            <dd className={cn('min-w-0 break-words text-fg', item.mono && 'font-mono text-xs')}>
              {item.value ?? <span className="text-fg-subtle">—</span>}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
