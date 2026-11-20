import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ADMITS_TEMPLATE_CAP } from '@/shared/contracts/scanners.ts';
import { Badge, CheckboxField, ErrorState, Input, SwitchRow } from '@/web/ui/index.ts';
import { useEligibleTemplates, useOrgTemplates, useScanEvents } from '../scanner-api.ts';

export const ADMITS_EVENT_CAP = 10;

interface Option {
  id: string;
  name: string;
  note?: string;
}

const toggle = (list: string[], id: string, on: boolean) =>
  on ? [...list, id] : list.filter((x) => x !== id);

function Group({
  title,
  count,
  cap,
  options,
  selected,
  onToggle,
  empty,
}: {
  title: string;
  count: number;
  cap: number;
  options: Option[];
  selected: string[];
  onToggle: (id: string, on: boolean) => void;
  empty: string;
}) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-1">
      <legend className="mb-1 flex w-full items-baseline justify-between text-sm font-medium text-fg">
        {title}
        <span className="text-xs font-normal text-fg-muted tabular-nums">
          {count} of {cap}
        </span>
      </legend>
      {options.map((o) => {
        const on = selected.includes(o.id);
        return (
          <CheckboxField
            key={o.id}
            checked={on}
            disabled={!on && count >= cap}
            label={
              <>
                {o.name}
                {o.note ? <span className="ml-2 text-xs text-fg-muted">{o.note}</span> : null}
              </>
            }
            onCheckedChange={(v) => onToggle(o.id, v === true)}
          />
        );
      })}
      {options.length === 0 ? <p className="text-sm text-fg-muted">{empty}</p> : null}
    </fieldset>
  );
}

/**
 * What a session admits: pass types and events together, or any pass type. One list per kind, a
 * search over both, and the chosen ones as chips that come off with one tap.
 */
export function AdmitsPicker({
  orgId,
  any,
  templateIds,
  eventIds,
  onAnyChange,
  onChange,
  error,
}: {
  orgId: string;
  any: boolean;
  templateIds: string[];
  eventIds: string[];
  onAnyChange: (any: boolean) => void;
  onChange: (patch: { templateIds?: string[]; eventIds?: string[] }) => void;
  error?: string | undefined;
}) {
  const [q, setQ] = useState('');
  const types = useEligibleTemplates(orgId || undefined, Boolean(orgId) && !any);
  const events = useScanEvents(orgId || undefined, Boolean(orgId) && !any);
  const loaded = types.data?.pages.flatMap((p) => p.items) ?? [];
  const missing = templateIds.filter((id) => !loaded.some((t) => t.templateId === id));
  const names = useOrgTemplates(
    orgId && !any && missing.length && types.isFetched && !types.hasNextPage ? orgId : undefined,
  );
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = types;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  const typeName = (id: string) =>
    loaded.find((t) => t.templateId === id)?.name ??
    names.data?.items.find((t) => t.id === id)?.name ??
    'Pass type';
  const typeOptions: Option[] = loaded.map((t) => ({
    id: t.templateId,
    name: t.name,
  }));
  // A chosen type that is not approved any more stays listed, so it can be removed.
  for (const id of templateIds)
    if (!typeOptions.some((o) => o.id === id) && types.isFetched && !hasNextPage)
      typeOptions.push({ id, name: typeName(id), note: 'not approved' });
  const allEvents = events.data?.items ?? [];
  const eventOptions: Option[] = allEvents
    .filter((e) => eventIds.includes(e.id) || e.status === 'upcoming' || e.status === 'live')
    .map((e) => ({
      id: e.id,
      name: e.name,
      note: e.status,
    }));
  for (const id of eventIds)
    if (!eventOptions.some((o) => o.id === id) && events.isFetched)
      eventOptions.push({ id, name: 'Event', note: 'gone' });
  const match = (o: Option) => o.name.toLowerCase().includes(q.trim().toLowerCase());
  const chips = [
    ...templateIds.map((id) => ({ id, kind: 'type' as const, name: typeName(id) })),
    ...eventIds.map((id) => ({
      id,
      kind: 'event' as const,
      name: allEvents.find((e) => e.id === id)?.name ?? 'Event',
    })),
  ];
  return (
    <div className="grid gap-4">
      <SwitchRow
        label="Any pass type"
        help="Every pass this organization issues."
        checked={any}
        onCheckedChange={onAnyChange}
      />
      {any ? null : (
        <>
          <Input
            type="search"
            aria-label="Search pass types and events"
            placeholder="Search pass types and events"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            maxLength={80}
          />
          {chips.length ? (
            <ul className="flex flex-wrap gap-2" aria-label="Admitted">
              {chips.map((c) => (
                <li key={`${c.kind}-${c.id}`}>
                  <Badge tone={c.kind === 'event' ? 'info' : 'accent'} className="gap-1.5 pe-1">
                    {c.name}
                    <button
                      type="button"
                      aria-label={`Remove ${c.name}`}
                      className="grid size-5 place-items-center rounded-full hover:bg-state-hover-tint"
                      onClick={() =>
                        onChange(
                          c.kind === 'type'
                            ? { templateIds: toggle(templateIds, c.id, false) }
                            : { eventIds: toggle(eventIds, c.id, false) },
                        )
                      }
                    >
                      <X aria-hidden className="size-3" />
                    </button>
                  </Badge>
                </li>
              ))}
            </ul>
          ) : null}
          <Group
            title="Pass types"
            count={templateIds.length}
            cap={ADMITS_TEMPLATE_CAP}
            options={typeOptions.filter(match)}
            selected={templateIds}
            onToggle={(id, on) => onChange({ templateIds: toggle(templateIds, id, on) })}
            empty={
              types.isFetching ? 'Loading…' : q ? 'No pass types match.' : 'No approved pass types.'
            }
          />
          <Group
            title="Events"
            count={eventIds.length}
            cap={ADMITS_EVENT_CAP}
            options={eventOptions.filter(match)}
            selected={eventIds}
            onToggle={(id, on) => onChange({ eventIds: toggle(eventIds, id, on) })}
            empty={events.isFetching ? 'Loading…' : q ? 'No events match.' : 'No open events.'}
          />
          {types.isError ? (
            <ErrorState
              inline
              subject="pass types"
              error={types.error}
              onRetry={() => types.refetch()}
            />
          ) : null}
        </>
      )}
      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </div>
  );
}
