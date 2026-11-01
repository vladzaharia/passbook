import { Link } from '@tanstack/react-router';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useId, useState } from 'react';
import { cn } from '@/web/lib/cn.ts';
import { Button, buttonVariants, EntityIcon, KeyValue, StatusPill } from '@/web/ui/index.ts';
import type { DataItem } from './data-items.ts';
import { type Component, componentLink, pillStatus, summaryLine } from './groups.ts';
import { COMPONENT_ICON } from './icons.ts';
import './status.css';

const EDGE: Partial<Record<Component['state'], string>> = {
  failing: 'border-l-danger',
  degraded: 'border-l-warning',
};

/** Keeps pills aligned on rows without a page to open. */
const OPEN_SLOT = cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'max-sm:px-2');

/**
 * Icon, label and one line; then the pill, "Open" to the page that owns it, and a disclosure for
 * the technical data.
 */
export function ComponentRow({ component: c, items }: { component: Component; items: DataItem[] }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const line = summaryLine(c);
  const link = componentLink(c);
  const label = c.id === 'connections' ? 'All connections' : c.label;
  const openLabel = (
    <>
      <span className="max-sm:sr-only">Open</span>
      <ChevronRight aria-hidden />
    </>
  );
  return (
    <li className={cn('border-l-2 border-l-transparent', EDGE[c.state])}>
      <div className="flex items-center gap-3 py-3 pr-2 pl-4">
        <EntityIcon icon={COMPONENT_ICON[c.kind]} className="max-sm:hidden" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-fg-strong">{label}</p>
          {line ? <p className="truncate text-xs text-fg-muted">{line}</p> : null}
        </div>
        <StatusPill status={pillStatus(c)} className="shrink-0" />
        <div className="flex shrink-0 items-center">
          {link ? (
            <Button asChild variant="ghost" size="sm" className="max-sm:px-2">
              <Link to={link} aria-label={`Open ${label}`}>
                {openLabel}
              </Link>
            </Button>
          ) : (
            <span aria-hidden className={cn(OPEN_SLOT, 'invisible')}>
              {openLabel}
            </span>
          )}
          {items.length > 0 ? (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={`${id}-data`}
              aria-label={`${label} details`}
              onClick={() => setOpen((v) => !v)}
              className={cn(
                buttonVariants({ variant: 'ghost', size: 'sm' }),
                'size-8 min-w-8 px-0 text-fg-muted',
              )}
            >
              <ChevronDown aria-hidden className="wl-chevron" />
            </button>
          ) : (
            <span aria-hidden className="size-8" />
          )}
        </div>
      </div>
      {open ? (
        <div
          id={`${id}-data`}
          className="wl-disclose border-t border-border bg-surface-sunken/50 px-4 py-3 sm:pl-16"
        >
          <KeyValue items={items} />
        </div>
      ) : null}
    </li>
  );
}
