import { Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useOrgOptions } from '../../lib/search.ts';
import { Button, Input, Select } from '../../ui/index.ts';
import { useConnections } from '../connections/api.ts';
import { useTemplates } from '../templates/api.ts';
import type { PassFilters } from './api.ts';

const ALL = 'all';

export interface ListSearch extends PassFilters {}

function Filter({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | undefined;
  options: { value: string; label: string }[];
  onChange: (v: string | undefined) => void;
}) {
  return (
    <Select
      aria-label={label}
      className="w-40"
      value={value ?? ALL}
      onValueChange={(v) => onChange(v === ALL ? undefined : v)}
      options={[{ value: ALL, label: `${label}: all` }, ...options]}
    />
  );
}

/** Text search is debounced so the URL and the query change once per pause. */
function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (draft === value) return;
    const t = setTimeout(() => onChange(draft), 250);
    return () => clearTimeout(t);
  }, [draft, value, onChange]);
  return (
    <div className="relative w-full sm:w-64">
      <Search
        aria-hidden
        className="pointer-events-none absolute top-2.5 left-3 size-4 text-fg-muted"
      />
      <Input
        type="search"
        aria-label="Search passes"
        placeholder="Search title, serial, email"
        className="pl-9"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
    </div>
  );
}

export function PassListFilters({
  search,
  onChange,
}: {
  search: ListSearch;
  onChange: (patch: Partial<ListSearch>) => void;
}) {
  const orgs = useOrgOptions();
  const templates = useTemplates({ orgId: search.orgId });
  const connections = useConnections({ orgId: search.orgId });
  const active = Object.values(search).some((v) => v !== undefined && v !== '');
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <SearchBox value={search.q ?? ''} onChange={(q) => onChange({ q: q || undefined })} />
      <Filter
        label="Org"
        value={search.orgId}
        onChange={(orgId) => onChange({ orgId, templateId: undefined, connectionId: undefined })}
        options={(orgs.data?.items ?? []).map((o) => ({ value: o.id, label: o.name }))}
      />
      <Filter
        label="Template"
        value={search.templateId}
        onChange={(templateId) => onChange({ templateId })}
        options={(templates.data?.items ?? []).map((t) => ({ value: t.id, label: t.name }))}
      />
      <Filter
        label="Status"
        value={search.status}
        onChange={(status) => onChange({ status: status as PassFilters['status'] })}
        options={[
          { value: 'active', label: 'Active' },
          { value: 'voided', label: 'Voided' },
        ]}
      />
      <Filter
        label="Connection"
        value={search.connectionId}
        onChange={(connectionId) => onChange({ connectionId })}
        options={(connections.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))}
      />
      <Filter
        label="Holder"
        value={search.holderState}
        onChange={(holderState) =>
          onChange({ holderState: holderState as PassFilters['holderState'] })
        }
        options={[
          { value: 'unassigned', label: 'Unassigned' },
          { value: 'waiting', label: 'Waiting' },
          { value: 'owned', label: 'Owned' },
        ]}
      />
      {active ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            onChange({
              q: undefined,
              orgId: undefined,
              templateId: undefined,
              connectionId: undefined,
              status: undefined,
              holderState: undefined,
            })
          }
        >
          Clear
        </Button>
      ) : null}
    </div>
  );
}
