import { FilterBar, type FilterDef } from '../../ui/index.ts';
import { useConnections } from '../connections/api.ts';
import type { PassFilters } from './api.ts';

export interface ListSearch extends Omit<PassFilters, 'orgId' | 'orgIds' | 'match'> {
  /** The All scope's Organization filter: ids joined by commas. */
  orgIds?: string | undefined;
  /** The query bar's chips (JSON): see find-query.ts. */
  m?: string | undefined;
}

export const CLEARED: { [K in keyof Required<ListSearch>]: undefined } = {
  q: undefined,
  templateId: undefined,
  connectionId: undefined,
  importId: undefined,
  status: undefined,
  holderState: undefined,
  onDevice: undefined,
  noScanDays: undefined,
  m: undefined,
  orgIds: undefined,
};

const ANY = 'all';
const pick = <T extends string>(v: string): T | undefined => (v === ANY ? undefined : (v as T));

/** Status and Holder inline; the rest join Filters below 1280. Search and Template are the query bar's. */
export function PassListFilters({
  search,
  orgId,
  all = false,
  onChange,
}: {
  search: ListSearch;
  orgId: string | undefined;
  /** The All scope: filters that need one organization's connections stay out. */
  all?: boolean;
  onChange: (patch: Partial<ListSearch>) => void;
}) {
  const connections = useConnections({ orgId });
  const defs: FilterDef[] = [
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
    ...(search.importId
      ? [
          {
            id: 'import',
            label: 'Source',
            value: search.importId,
            defaultValue: ANY,
            options: [
              { value: ANY, label: 'All passes' },
              { value: search.importId, label: 'From this import' },
            ],
            onChange: (v: string) => onChange({ importId: pick(v) }),
          },
        ]
      : []),
  ];
  // Connections and imports belong to one organization.
  const filters = all ? defs.filter((f) => f.id !== 'connection' && f.id !== 'import') : defs;
  return <FilterBar maxInline={5} filters={filters} onClear={() => onChange(CLEARED)} />;
}
