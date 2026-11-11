import { SlidersHorizontal, X } from 'lucide-react';
import { useId, useState } from 'react';
import { ACTIONS } from '@/web/lib/actions.ts';
import { cn } from '@/web/lib/cn.ts';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import { useMemberships } from '@/web/lib/session.ts';
import {
  Button,
  Combobox,
  type ComboboxOption,
  EntityPicker,
  IconButton,
  Input,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/web/ui/index.ts';
import { useOrgPages } from '../orgs/org-pages.ts';
import type { AuditSearch } from './audit-search.ts';
import { DateFilter } from './date-filter.tsx';
import { targetTypeLabel } from './labels.ts';

const ANY = '';

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
 * Action, date, then organization, user, pass and connection filters. A pass and a connection
 * are both targets, so picking one replaces the other.
 */
export function AuditFilters({ search, onSearch, names }: AuditFiltersProps) {
  const id = useId();
  const [manualKind, setManualKind] = useState<'pass' | 'connection'>();
  const [manualId, setManualId] = useState('');
  const scope = useOrgScope();
  const memberships = useMemberships();
  const canSearchTenant = Boolean(
    search.filterOrgId &&
      search.filterOrgId === scope.orgId &&
      !scope.isError &&
      !memberships.isFetching,
  );
  const canSearchPasses = canSearchTenant && scope.membership?.capabilities.includes('passes:read');
  const canSearchConnections =
    canSearchTenant && scope.membership?.capabilities.includes('integrations:read');
  const orgs = useOrgPages();
  const orgItems = orgs.data?.pages.flatMap((page) => page.items) ?? [];
  const orgOptions = [
    { value: ANY, label: 'All organizations' },
    ...(search.filterOrgId && !orgItems.some((org) => org.id === search.filterOrgId)
      ? [{ value: search.filterOrgId, label: names.org ?? search.filterOrgId }]
      : []),
    ...orgItems.map((org) => ({ value: org.id, label: org.name })),
  ];
  const patch = (p: AuditSearch) => onSearch({ ...search, ...p });
  const pass = search.targetType === 'pass' ? search.targetId : undefined;
  const connection = search.targetType === 'connection' ? search.targetId : undefined;
  const otherTarget =
    Boolean(search.targetType || search.targetId) &&
    (!search.targetId ||
      !search.targetType ||
      (search.targetType === 'pass' && !canSearchPasses) ||
      (search.targetType === 'connection' && !canSearchConnections) ||
      (search.targetType !== 'pass' && search.targetType !== 'connection'));
  const extra = [search.actorId, search.targetId ?? search.targetType, search.filterOrgId].filter(
    Boolean,
  ).length;
  const any = Object.values(search).some((v) => v !== undefined);
  const target = (type: string) => (id: string) => patch({ targetType: type, targetId: id });
  const actions =
    search.action && !ACTION_OPTIONS.some((option) => option.value === search.action)
      ? [...ACTION_OPTIONS, { value: search.action, label: `${search.action} (prefix)` }]
      : ACTION_OPTIONS;
  const clearTarget = () => patch({ targetType: undefined, targetId: undefined });

  return (
    <search aria-label="Filters" className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <div className="flex min-w-0 flex-col gap-2">
        <Label htmlFor={`${id}-action`}>Action</Label>
        <Combobox
          id={`${id}-action`}
          aria-label="Action"
          className="w-full"
          options={actions}
          value={search.action ?? ANY}
          onValueChange={(v) => patch({ action: v === ANY ? undefined : v })}
          searchPlaceholder="Search actions"
        />
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <span className="text-sm font-medium text-fg">Date</span>
        <DateFilter
          from={search.from}
          to={search.to}
          onChange={(r) => patch(r)}
          className="w-full"
        />
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <span className="text-sm font-medium text-fg">Organization, people and resources</span>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              iconStart={<SlidersHorizontal aria-hidden />}
              className={cn(extra > 0 && 'border-accent bg-accent-subtle', 'w-full justify-start')}
            >
              Filters{extra ? ` (${extra})` : ''}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="flex max-h-[calc(100dvh-2rem)] w-80 max-w-[calc(100vw-2rem)] flex-col gap-4 overflow-y-auto"
          >
            <Picked
              label="Organization"
              set={Boolean(search.filterOrgId)}
              onClear={() => patch({ filterOrgId: undefined })}
            >
              {(id) => (
                <>
                  <Combobox
                    id={id}
                    options={orgOptions}
                    value={search.filterOrgId ?? ANY}
                    onValueChange={(value) => patch({ filterOrgId: value || undefined })}
                    searchPlaceholder="Search loaded organizations"
                    loading={orgs.isPending}
                  />
                  {orgs.isError ? (
                    <div className="text-sm text-danger">
                      Organizations could not be loaded.{' '}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          void (orgs.isFetchNextPageError ? orgs.fetchNextPage() : orgs.refetch())
                        }
                      >
                        Retry organizations
                      </Button>
                    </div>
                  ) : orgs.hasNextPage ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="self-start"
                      loading={orgs.isFetchingNextPage}
                      onClick={() => void orgs.fetchNextPage()}
                    >
                      Load more organizations
                    </Button>
                  ) : null}
                </>
              )}
            </Picked>
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
            {canSearchPasses ? (
              <Picked label="Pass" set={Boolean(pass)} onClear={clearTarget}>
                {(id) => (
                  <EntityPicker
                    id={id}
                    kind="pass"
                    value={pass}
                    valueLabel={pass ? (names.target ?? pass) : undefined}
                    placeholder="Any pass"
                    onValueChange={target('pass')}
                  />
                )}
              </Picked>
            ) : null}
            {canSearchConnections ? (
              <Picked label="Connection" set={Boolean(connection)} onClear={clearTarget}>
                {(id) => (
                  <EntityPicker
                    id={id}
                    kind="connection"
                    value={connection}
                    valueLabel={connection ? (names.target ?? connection) : undefined}
                    placeholder="Any connection"
                    onValueChange={target('connection')}
                  />
                )}
              </Picked>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {(['pass', 'connection'] as const).map((kind) => (
                <Button
                  key={kind}
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setManualKind(kind);
                    setManualId((kind === 'pass' ? pass : connection) ?? '');
                  }}
                >
                  Enter {kind} ID
                </Button>
              ))}
            </div>
            {manualKind ? (
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${id}-resource-id`}>
                  {manualKind === 'pass' ? 'Pass ID' : 'Connection ID'}
                </Label>
                <Input
                  id={`${id}-resource-id`}
                  value={manualId}
                  maxLength={100}
                  onChange={(event) => setManualId(event.target.value)}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!manualId.trim()}
                  onClick={() => {
                    target(manualKind)(manualId.trim());
                    setManualKind(undefined);
                  }}
                >
                  Apply {manualKind} ID
                </Button>
              </div>
            ) : null}
            {otherTarget ? (
              <div className="flex items-center justify-between gap-2 rounded-md bg-accent-subtle px-3 py-2">
                <span className="min-w-0 truncate">
                  <span className="text-fg-muted">
                    {search.targetType ? targetTypeLabel(search.targetType) : 'Target'}:{' '}
                  </span>
                  {names.target ?? search.targetId ?? 'all'}
                </span>
                <IconButton
                  label="Clear target"
                  size="sm"
                  icon={<X aria-hidden />}
                  onClick={clearTarget}
                />
              </div>
            ) : null}
          </PopoverContent>
        </Popover>
      </div>
      {any ? (
        <div className="sm:col-span-2 lg:col-span-3">
          <Button variant="ghost" iconStart={<X aria-hidden />} onClick={() => onSearch({})}>
            Clear event filters
          </Button>
        </div>
      ) : null}
    </search>
  );
}
