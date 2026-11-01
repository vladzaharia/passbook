import { Link } from '@tanstack/react-router';
import { cn } from '@/web/lib/cn.ts';
import { EntityChip } from '@/web/ui/index.ts';
import type { Ref } from './labels.ts';

/**
 * An actor or target: the kit EntityChip for entities, the same look for the rest (settings,
 * sessions, the system). Links stop the row click, so a target opens its page, not the drawer.
 */
export function RefChip({ value, className }: { value: Ref; className?: string }) {
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  if (value.kind) {
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: keeps the row's pointer shortcut off the link
      // biome-ignore lint/a11y/useKeyWithClickEvents: the link inside handles keys
      <span
        onClick={stop}
        title={value.name}
        className={cn('inline-flex max-w-full min-w-0', className)}
      >
        <EntityChip kind={value.kind} id={value.name} name={value.name} to={value.to} />
      </span>
    );
  }
  const body = (
    <>
      <value.icon aria-hidden className="size-3.5 shrink-0 text-fg-muted" />
      <span className="truncate">{value.name}</span>
    </>
  );
  const classes = cn('inline-flex max-w-full min-w-0 items-center gap-1 align-bottom', className);
  if (!value.to)
    return (
      <span title={value.name} className={classes}>
        {body}
      </span>
    );
  return (
    <Link
      to={value.to}
      onClick={stop}
      className={cn(
        classes,
        'rounded-sm text-fg hover:text-fg-strong hover:underline underline-offset-2',
      )}
    >
      {body}
    </Link>
  );
}
