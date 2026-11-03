import { cn } from '@/web/lib/cn.ts';
import { MetaLink } from '@/web/ui/index.ts';
import type { Ref } from './labels.ts';

const REF = 'max-w-full min-w-0 gap-1 align-bottom [&_svg]:size-3.5 [&_svg]:shrink-0';

/**
 * An actor or target, icon first. One that has a page is a MetaLink (muted, strong on hover); the
 * link stops the row click, so it opens its page, not the drawer.
 */
export function RefChip({ value, className }: { value: Ref; className?: string }) {
  const name = <span className="truncate">{value.name}</span>;
  if (!value.to) {
    return (
      <span
        title={value.name}
        className={cn('inline-flex items-center text-fg-muted', REF, className)}
      >
        <value.icon aria-hidden />
        {name}
      </span>
    );
  }
  return (
    <MetaLink
      to={value.to}
      icon={value.icon}
      title={value.name}
      onClick={(e) => e.stopPropagation()}
      className={cn(REF, className)}
    >
      {name}
    </MetaLink>
  );
}
