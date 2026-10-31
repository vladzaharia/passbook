import type { ReactNode } from 'react';
import { cn } from '../lib/cn.ts';

export interface KeyValueItem {
  label: string;
  value: ReactNode;
  mono?: boolean;
}

export function KeyValue({
  items,
  className,
}: {
  items: readonly KeyValueItem[];
  className?: string;
}) {
  return (
    <dl
      className={cn(
        'grid grid-cols-[minmax(7rem,max-content)_1fr] gap-x-6 gap-y-2 text-sm',
        className,
      )}
    >
      {items.map((item) => (
        <div key={item.label} className="contents">
          <dt className="text-fg-muted">{item.label}</dt>
          <dd
            className={cn('min-w-0 break-words text-fg-strong', item.mono && 'font-mono text-xs')}
          >
            {item.value ?? <span className="text-fg-subtle">—</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}
