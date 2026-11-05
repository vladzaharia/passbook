import { useRouterState } from '@tanstack/react-router';
import { Building2 } from 'lucide-react';
import { isOrgScoped } from '../../lib/nav.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { useOrgOptions } from '../../lib/search.ts';
import { Combobox } from '../combobox.tsx';
import { EntityAvatar } from '../entity.tsx';

const ALL = 'all';

/**
 * The only org control: a combobox in the top bar, hidden where the scope does not apply. It
 * writes `?orgId=` (useOrgScope). Shows the full name (truncating when the bar runs out of room); below sm, the avatar and chevron.
 */
export function ScopeSwitcher() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { orgId, setOrgId } = useOrgScope();
  const scoped = isOrgScoped(pathname);
  const { data } = useOrgOptions(scoped);
  if (!scoped) return null;
  const options = [
    {
      value: ALL,
      label: 'All organizations',
      icon: <Building2 aria-hidden className="size-4 shrink-0 text-fg-muted" />,
    },
    ...(data?.items ?? []).map((o) => ({
      value: o.id,
      label: o.name,
      icon: <EntityAvatar kind="org" id={o.id} name={o.name} accent={o.branding.accent} />,
    })),
  ];
  return (
    <Combobox
      aria-label="Organization scope"
      searchPlaceholder="Find an organization"
      className="w-auto min-w-0 gap-1.5 px-2.5"
      options={options}
      compact
      value={orgId ?? ALL}
      onValueChange={(v) => setOrgId(v === ALL ? undefined : v)}
    />
  );
}
