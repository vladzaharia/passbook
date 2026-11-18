import { Archive, Building2, CornerDownRight, Pencil, Plus, RotateCcw, Users } from 'lucide-react';
import type { ScanZone } from '@/shared/contracts/scan-access.ts';
import { cn } from '@/web/lib/cn.ts';
import { zoneLabel as clockLabel } from '@/web/lib/timezones.ts';
import { Badge, ProgressBar, type RowAction, RowActions } from '@/web/ui/index.ts';
import { MAX_DEPTH, type ZoneNode } from './zone-tree.ts';

export interface ZoneActions {
  edit: (zone: ScanZone) => void;
  addInside: (zone: ScanZone) => void;
  archive: (node: ZoneNode) => void;
  restore: (zone: ScanZone) => void;
  inside?: (zone: ScanZone) => void;
}

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

function planNames(zone: ScanZone): string {
  const names = [...new Set(zone.plans.map((p) => p.label))];
  return names.length > 3
    ? `${names.slice(0, 3).join(', ')} +${names.length - 3}`
    : names.join(', ');
}

function Occupancy({ zone }: { zone: ScanZone }) {
  if (zone.occupancy === 'off') return <span className="text-fg-muted">—</span>;
  return (
    <Badge tone={zone.occupancy === 'enforce' ? 'accent' : 'neutral'}>
      {zone.occupancy === 'enforce' ? 'Tap out required' : 'Counts'}
    </Badge>
  );
}

/** In now against capacity: a bar when the zone is limited, the bare count when it is not. */
function InNow({ zone }: { zone: ScanZone }) {
  if (zone.inNow === null) return null;
  const { capacity, inNow } = zone;
  if (capacity === null)
    return <span className="text-xs text-fg-muted tabular-nums">{inNow} inside</span>;
  const full = inNow >= capacity;
  return (
    <span className="grid w-28 gap-1 text-xs text-fg-muted tabular-nums">
      <span>
        {inNow} / {capacity} inside
      </span>
      <ProgressBar
        label={`${zone.name} inside`}
        value={inNow}
        max={capacity}
        valueText={`${inNow} of ${capacity}`}
        tone={full ? 'danger' : inNow / capacity > 0.8 ? 'warning' : 'accent'}
      />
    </span>
  );
}

function actionsFor(node: ZoneNode, a: ZoneActions, canManage: boolean): RowAction[] {
  const { zone } = node;
  if (!canManage && !a.inside) return [];
  if (zone.archivedAt !== null)
    return canManage
      ? [{ label: 'Restore', icon: RotateCcw, onSelect: () => a.restore(zone) }]
      : [];
  return [
    ...(canManage ? [{ label: 'Edit', icon: Pencil, onSelect: () => a.edit(zone) }] : []),
    ...(canManage && zone.depth < MAX_DEPTH
      ? [{ label: 'Add a zone inside', icon: Plus, onSelect: () => a.addInside(zone) }]
      : []),
    ...(a.inside && zone.occupancy !== 'off'
      ? [{ label: 'Who’s inside', icon: Users, onSelect: () => a.inside?.(zone) }]
      : []),
    ...(canManage
      ? [{ label: 'Archive', icon: Archive, destructive: true, onSelect: () => a.archive(node) }]
      : []),
  ];
}

/**
 * The zones as one list: `aria-level` carries the depth, the indent shows it. A flat list keeps
 * every row's menu a plain button (a tree widget would promise arrow-key walking).
 */
export function ZoneTreeList({
  nodes,
  label,
  actions,
  canManage,
}: {
  nodes: readonly ZoneNode[];
  label: string;
  actions: ZoneActions;
  canManage: boolean;
}) {
  return (
    <ul
      aria-label={label}
      className="@container divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface-raised"
    >
      {nodes.map((node) => {
        const { zone, level } = node;
        const archived = zone.archivedAt !== null;
        const clock = zone.timeZone ?? zone.effectiveTimeZone;
        const menu = actionsFor(node, actions, canManage);
        return (
          // biome-ignore lint/a11y/useAriaPropsSupportedByRole: ARIA 1.2 allows aria-level on listitem; axe agrees
          <li
            key={zone.id}
            aria-level={level}
            style={{ '--lvl': level - 1 } as React.CSSProperties}
            className={cn(
              'flex items-center gap-3 py-3 pe-3 ps-[calc(0.75rem+var(--lvl)*1rem)] @[40rem]:ps-[calc(1rem+var(--lvl)*1.5rem)]',
              archived && 'bg-surface-sunken',
            )}
          >
            <span
              aria-hidden
              className={cn(
                'inline-flex size-9 shrink-0 items-center justify-center rounded-md border',
                level === 1
                  ? 'border-accent bg-accent-subtle text-accent-fg'
                  : 'border-border bg-surface-sunken text-fg-muted',
              )}
            >
              {level === 1 ? (
                <Building2 className="size-4" />
              ) : (
                <CornerDownRight className="size-4" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className={cn('truncate font-medium text-fg-strong', archived && 'text-fg-muted')}
                >
                  {zone.name}
                </span>
                {archived ? <Badge>Archived</Badge> : null}
              </div>
              <p className="line-clamp-2 text-xs text-fg-muted">
                <span className="font-mono">{zone.key}</span>
                {' · '}
                {count(zone.sessions, 'session')}
                {clock ? ` · ${clockLabel(clock)}` : ''}
                {zone.plans.length ? ` · ${planNames(zone)}` : ''}
                {zone.occupancy === 'off' ? null : (
                  <span className="@[40rem]:hidden">
                    {zone.occupancy === 'enforce' ? ' · Tap out required' : ' · Counts'}
                    {zone.inNow === null ? '' : ` · ${zone.inNow} inside`}
                  </span>
                )}
              </p>
            </div>
            <div className="hidden shrink-0 items-center gap-4 @[40rem]:flex">
              <Occupancy zone={zone} />
              <InNow zone={zone} />
            </div>
            {menu.length ? <RowActions label={`Actions for ${zone.name}`} actions={menu} /> : null}
          </li>
        );
      })}
    </ul>
  );
}
