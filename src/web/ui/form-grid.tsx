import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn.ts';

/**
 * Form fields on a container query of the grid's own width: 1 column, 2 at 40rem, 3 short-field
 * columns at 64rem. Long fields (textarea, URL, JSON, lists) use <FormSpan full>. Inside a TwoPane
 * the grid narrows and drops columns by itself.
 */
export function FormGrid({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className="@container min-w-0">
      <div
        className={cn(
          'grid grid-cols-1 gap-4 @[40rem]:grid-cols-2 @[64rem]:grid-cols-3',
          className,
        )}
        {...props}
      />
    </div>
  );
}

/** A field that spans every column of its FormGrid. */
export function FormSpan({ full, children }: { full?: boolean; children: ReactNode }) {
  return <div className={cn('min-w-0', full && 'col-span-full')}>{children}</div>;
}

/**
 * A group heading in a form: text-sm semibold, 24 px above, a hairline. Hidden when it would
 * repeat its only field's label.
 */
export function FieldGroup({
  title,
  onlyFieldLabel,
  children,
  className,
}: {
  title: string;
  /** The label of the group's single field, when it has one. */
  onlyFieldLabel?: string;
  children: ReactNode;
  className?: string;
}) {
  const hidden = onlyFieldLabel !== undefined && onlyFieldLabel.trim() === title.trim();
  return (
    <section
      aria-label={hidden ? undefined : title}
      className={cn('min-w-0 first:[&>h3]:mt-0', className)}
    >
      {hidden ? null : (
        <h3 className="mt-6 mb-4 border-t border-border pt-6 text-sm font-semibold text-fg-strong">
          {title}
        </h3>
      )}
      {children}
    </section>
  );
}
