import type { LucideIcon } from 'lucide-react';
import { CircleCheck, Info, OctagonX, TriangleAlert } from 'lucide-react';
import { Children, type ReactNode } from 'react';
import { cn } from '../lib/cn.ts';

export type CalloutTone = 'info' | 'success' | 'warning' | 'danger';

const TONE: Record<CalloutTone, { icon: LucideIcon; box: string; text: string }> = {
  info: { icon: Info, box: 'border-info-border bg-info-subtle', text: 'text-info' },
  success: {
    icon: CircleCheck,
    box: 'border-success-border bg-success-subtle',
    text: 'text-success',
  },
  warning: {
    icon: TriangleAlert,
    box: 'border-warning-border bg-warning-subtle',
    text: 'text-warning',
  },
  danger: { icon: OctagonX, box: 'border-danger-border bg-danger-subtle', text: 'text-danger' },
};

export interface CalloutProps {
  tone?: CalloutTone;
  /** Overrides the tone glyph; the icon always shows. */
  icon?: LucideIcon;
  title?: ReactNode;
  /** One sentence, or a list of items (rendered as a list only for 2 or more). */
  children?: ReactNode;
  items?: readonly ReactNode[];
  actions?: ReactNode;
  className?: string;
}

/** A toned note with its icon, an optional title, a body at most 65ch wide and actions. */
export function Callout({
  tone = 'info',
  icon,
  title,
  children,
  items,
  actions,
  className,
}: CalloutProps) {
  const t = TONE[tone];
  const Icon = icon ?? t.icon;
  const list = items ?? [];
  return (
    <div
      role={tone === 'danger' ? 'alert' : undefined}
      className={cn('flex gap-3 rounded-lg border px-4 py-3 text-sm', t.box, className)}
    >
      {/* Centred on the first line at either type scale (console 20 px, holder 24 px lines). */}
      <Icon
        aria-hidden
        className={cn('mt-[calc(var(--pk-line-height-sm)/2-0.5rem)] size-4 shrink-0', t.text)}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {title ? <p className="font-medium text-fg-strong">{title}</p> : null}
        {children ? <div className="max-w-[65ch] text-fg">{children}</div> : null}
        {list.length > 1 ? (
          <ul className="max-w-[65ch] list-disc pl-4 text-fg">
            {Children.map(list, (item) => (
              <li>{item}</li>
            ))}
          </ul>
        ) : list.length === 1 ? (
          <p className="max-w-[65ch] text-fg">{list[0]}</p>
        ) : null}
        {actions ? <div className="mt-1 flex flex-wrap gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}
