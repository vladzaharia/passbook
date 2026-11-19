import { useDebouncedCommit } from '@/web/lib/debounce.ts';
import { FilterBar, type FilterDef } from '../../ui/index.ts';
import { useConnections } from '../connections/api.ts';
import type { PassFilters } from './api.ts';

export interface ListSearch extends Omit<PassFilters, 'orgId'> {}

export const CLEARED: { [K in keyof Required<ListSearch>]: undefined } = {
  q: undefined,
  templateId: undefined,
  connectionId: undefined,
  status: undefined,
  holderState: undefined,
  onDevice: undefined,
  noScanDays: undefined,
};

const ANY = 'all';
const pick = <T extends string>(v: string): T | undefined => (v === ANY ? undefined : (v as T));

/** Status and Template inline; Holder, On device and Connection join Filters below 1280. */
export function PassListFilters({
  search,
  orgId,
  templates,
  onChange,
}: {
  search: ListSearch;
  orgId: string | undefined;
  templates: { id: string; name: string }[];
  onChange: (patch: Partial<ListSearch>) => void;
}) {
  const connections = useConnections({ orgId });
  const [q, setQ] = useDebouncedCommit(search.q ?? '', (next) =>
    onChange({ q: next || undefined }),
  );
  const filters: FilterDef[] = [
    {
      id: 'status',
      label: 'Status',
      value: search.status ?? ANY,
      defaultValue: ANY,
      options: [
        { value: ANY, label: 'All' },
        { value: 'active', label: 'Active' },
        { value: 'voided', label: 'Voided' },
        { value: 'removed', label: 'Removed' },
      ],
      onChange: (v) => onChange({ status: pick(v) }),
    },
    {
      id: 'template',
      label: 'Template',
      value: search.templateId ?? ANY,
      defaultValue: ANY,
      options: [
        { value: ANY, label: 'All' },
        ...templates.map((t) => ({ value: t.id, label: t.name })),
      ],
      onChange: (v) => onChange({ templateId: pick(v) }),
    },
    {
      id: 'holder',
      label: 'Holder',
      value: search.holderState ?? ANY,
      defaultValue: ANY,
      options: [
        { value: ANY, label: 'Any' },
        { value: 'owned', label: 'Holder signed in' },
        { value: 'waiting', label: 'Not claimed' },
        { value: 'unassigned', label: 'No holder' },
      ],
      onChange: (v) => onChange({ holderState: pick(v) }),
    },
    {
      id: 'device',
      label: 'On device',
      value: search.onDevice ?? ANY,
      defaultValue: ANY,
      options: [
        { value: ANY, label: 'Any' },
        { value: 'true', label: 'Yes' },
        { value: 'false', label: 'No' },
      ],
      onChange: (v) => onChange({ onDevice: pick(v) }),
    },
    {
      id: 'scan',
      label: 'Last scan',
      value: search.noScanDays ? String(search.noScanDays) : ANY,
      defaultValue: ANY,
      options: [
        { value: ANY, label: 'Any' },
        { value: '30', label: 'No scan in 30 days' },
        { value: '90', label: 'No scan in 90 days' },
      ],
      onChange: (v) => onChange({ noScanDays: v === '30' ? 30 : v === '90' ? 90 : undefined }),
    },
    {
      id: 'connection',
      label: 'Connection',
      value: search.connectionId ?? ANY,
      defaultValue: ANY,
      options: [
        { value: ANY, label: 'Any' },
        ...(connections.data?.items ?? []).map((c) => ({ value: c.id, label: c.name })),
      ],
      onChange: (v) => onChange({ connectionId: pick(v) }),
    },
  ];
  return (
    <FilterBar
      maxInline={5}
      search={{ value: q, onChange: setQ, placeholder: 'Search passes' }}
      filters={filters}
      onClear={() => {
        setQ('');
        onChange(CLEARED);
      }}
    />
  );
}
