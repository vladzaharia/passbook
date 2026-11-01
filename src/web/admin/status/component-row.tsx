import {
  ChevronDown,
  Database,
  GitBranch,
  HardDrive,
  KeyRound,
  Layers,
  type LucideIcon,
  Mail,
  Package,
  Plug,
  ShieldCheck,
  Timer,
} from 'lucide-react';
import { cn } from '@/web/lib/cn.ts';
import { KeyValue, StatusPill } from '@/web/ui/index.ts';
import type { DataItem } from './data-items.ts';
import { type Component, summaryLine } from './groups.ts';

const ICONS: Record<Component['kind'], LucideIcon> = {
  database: Database,
  storage: HardDrive,
  queue: Layers,
  cron: Timer,
  build: Package,
  email: Mail,
  identity: ShieldCheck,
  oidc: KeyRound,
  connection: Plug,
  workflow: GitBranch,
};

const EDGE: Partial<Record<Component['state'], string>> = {
  failing: 'border-l-danger',
  degraded: 'border-l-warning',
};

function Head({ c }: { c: Component }) {
  const Icon = ICONS[c.kind];
  const line = summaryLine(c);
  return (
    <>
      <span
        aria-hidden
        className="grid size-9 shrink-0 place-items-center rounded-md bg-surface-sunken text-fg-muted"
      >
        <Icon className="size-4.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-fg-strong">
          {c.id === 'connections' ? 'All connections' : c.label}
        </span>
        {line ? <span className="block text-sm text-fg-muted">{line}</span> : null}
      </span>
      <StatusPill status={c.state} />
    </>
  );
}

/** Technical data stays behind a disclosure; rows without data are plain. */
export function ComponentRow({ component: c, items }: { component: Component; items: DataItem[] }) {
  const edge = cn('border-l-2 border-l-transparent', EDGE[c.state]);
  if (items.length === 0) {
    return (
      <li className={cn('flex items-center gap-3 px-4 py-3', edge)}>
        <Head c={c} />
        <span aria-hidden className="size-4 shrink-0" />
      </li>
    );
  }
  return (
    <li className={edge}>
      <details className="group">
        <summary
          className={cn(
            'flex cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden',
            'hover:bg-state-hover-tint focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
          )}
        >
          <Head c={c} />
          <ChevronDown
            aria-hidden
            className="size-4 shrink-0 text-fg-muted transition-transform group-open:rotate-180"
          />
          <span className="sr-only">Details</span>
        </summary>
        <div className="border-t border-border bg-surface-sunken/50 px-4 py-3 pl-16">
          <KeyValue items={items} />
        </div>
      </details>
    </li>
  );
}
