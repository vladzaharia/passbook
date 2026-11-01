import { SlidersHorizontal, X } from 'lucide-react';
import { useId } from 'react';
import { ACTIONS } from '@/web/lib/actions.ts';
import { cn } from '@/web/lib/cn.ts';
import {
  Button,
  Combobox,
  type ComboboxOption,
  EntityPicker,
  IconButton,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/web/ui/index.ts';
import type { AuditSearch } from './audit-search.ts';
import { DateFilter } from './date-filter.tsx';
import { targetTypeLabel } from './labels.ts';

const ANY = 'any';

/** Every known action by its label; the server matches the code as a prefix. */
const ACTION_OPTIONS: ComboboxOption[] = [
  { value: ANY, label: 'Any action' },
  ...Object.entries(ACTIONS)
    .map(([code, a]) => ({
      value: code,
      label: a.label,
      icon: <a.icon aria-hidden className="size-4 shrink-0 text-fg-muted" />,
    }))
    .sort((x, y) => x.label.localeCompare(y.label)),
];

/** Pickers with a remove button once set, so one filter clears without the rest. */
function Picked({
  label,
  set,
  onClear,
  children,
}: {
  label: string;
  set: boolean;
  onClear: () => void;
  children: (id: string) => React.ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        {set ? (
          <Button
            variant="ghost"
            size="sm"
            className="-my-1 min-h-6 px-2"
            aria-label={`Clear ${label.toLowerCase()}`}
            onClick={onClear}
          >
            Clear
          </Button>
        ) : null}
      </div>
      {children(id)}
    </div>
  );
}

export interface AuditFiltersProps {
  search: AuditSearch;
  onSearch: (next: AuditSearch) => void;
  /** Names for a deep-linked user or pass that the pickers have not loaded. */
  names: { actor?: string | undefined; target?: string | undefined; org?: string | undefined };
}

/**
 * Action, "Date: any", then Filters (n): user, pass and connection pickers. Never a raw id. A
 * pass and a connection are both targets, so picking one replaces the other.
 */
export function AuditFilters({ search, onSearch, names }: AuditFiltersProps) {
  const patch = (p: AuditSearch) => onSearch({ ...search, ...p });
  const pass = search.targetType === 'pass' ? search.targetId : undefined;
  const connection = search.targetType === 'connection' ? search.targetId : undefined;
  const otherTarget =
    search.targetType && search.targetType !== 'pass' && search.targetType !== 'connection';
  const extra = [search.actorId, search.targetId, search.orgId].filter(Boolean).length;
  const any = Object.values(search).some((v) => v !== undefined);
  const target = (type: string) => (id: string) => patch({ targetType: type, targetId: id });
  const clearTarget = () => patch({ targetType: undefined, targetId: undefined });

  return (
    <search
      aria-label="Filters"
      className="mb-3 flex flex-wrap items-center gap-2 max-sm:grid max-sm:grid-cols-2"
    >
      <Combobox
        aria-label="Action"
        className="max-sm:col-span-2 sm:w-64"
        options={ACTION_OPTIONS}
        value={search.action ?? ANY}
        onValueChange={(v) => patch({ action: v === ANY ? undefined : v })}
        searchPlaceholder="Search actions"
      />
      <DateFilter
        from={search.from}
        to={search.to}
        onChange={(r) => patch(r)}
        className="w-auto min-w-36 max-sm:w-full"
      />
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            iconStart={<SlidersHorizontal aria-hidden />}
            className={cn(extra > 0 && 'border-accent bg-accent-subtle', 'max-sm:w-full')}
          >
            Filters{extra ? ` (${extra})` : ''}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-4">
          <Picked
            label="User"
            set={Boolean(search.actorId)}
            onClear={() => patch({ actorId: undefined })}
          >
            {(id) => (
              <EntityPicker
                id={id}
                kind="user"
                value={search.actorId}
                valueLabel={names.actor}
                placeholder="Any user"
                onValueChange={(v) => patch({ actorId: v })}
              />
            )}
          </Picked>
          <Picked label="Pass" set={Boolean(pass)} onClear={clearTarget}>
            {(id) => (
              <EntityPicker
                id={id}
                kind="pass"
                value={pass}
                valueLabel={pass ? names.target : undefined}
                placeholder="Any pass"
                onValueChange={target('pass')}
              />
            )}
          </Picked>
          <Picked label="Connection" set={Boolean(connection)} onClear={clearTarget}>
            {(id) => (
              <EntityPicker
                id={id}
                kind="connection"
                value={connection}
                valueLabel={connection ? names.target : undefined}
                placeholder="Any connection"
                onValueChange={target('connection')}
              />
            )}
          </Picked>
          {otherTarget && search.targetType ? (
            <div className="flex items-center justify-between gap-2 rounded-md bg-accent-subtle px-3 py-2">
              <span className="min-w-0 truncate">
                <span className="text-fg-muted">{targetTypeLabel(search.targetType)}: </span>
                {names.target ?? 'selected'}
              </span>
              <IconButton
                label="Clear target"
                size="sm"
                icon={<X aria-hidden />}
                onClick={clearTarget}
              />
            </div>
          ) : null}
          {search.orgId ? (
            <div className="flex items-center justify-between gap-2 rounded-md bg-accent-subtle px-3 py-2">
              <span className="min-w-0 truncate">
                <span className="text-fg-muted">Organization: </span>
                {names.org ?? 'selected'}
              </span>
              <IconButton
                label="Clear organization"
                size="sm"
                icon={<X aria-hidden />}
                onClick={() => patch({ orgId: undefined })}
              />
            </div>
          ) : null}
        </PopoverContent>
      </Popover>
      {any ? (
        <Button variant="ghost" iconStart={<X aria-hidden />} onClick={() => onSearch({})}>
          Clear
        </Button>
      ) : null}
    </search>
  );
}
