import { useOrgFilter } from '../../lib/org-filter.tsx';
import { useOrgOptions } from '../../lib/search.ts';
import { Select } from '../select.tsx';

const ALL = 'all';

export function OrgFilter() {
  const { orgId, setOrgId } = useOrgFilter();
  const { data } = useOrgOptions();
  const options = [
    { value: ALL, label: 'All orgs' },
    ...(data?.items ?? []).map((o) => ({ value: o.id, label: o.name })),
  ];
  return (
    <Select
      aria-label="Organization filter"
      className="w-28 shrink-0 sm:w-56"
      options={options}
      value={orgId ?? ALL}
      onValueChange={(v) => setOrgId(v === ALL ? undefined : v)}
    />
  );
}
