import { useRouterState } from '@tanstack/react-router';
import { Building2 } from 'lucide-react';
import { isOrgScoped } from '../../lib/nav.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { useOrgOptions } from '../../lib/search.ts';
import { Combobox } from '../combobox.tsx';
import { EntityAvatar } from '../entity.tsx';

const ALL = 'all';

/** The only org control: a compact combobox in the top bar, hidden where the scope does not apply. */
export function ScopeSwitcher() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { orgId, setOrgId } = useOrgScope();
  const scoped = isOrgScoped(pathname);
  const { data } = useOrgOptions(scoped);
  if (!scoped) return null;
  const options = [
    {
      value: ALL,
      label: 'All orgs',
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
      className="w-auto max-w-44 shrink-0 gap-1.5 px-2.5"
      options={options}
      value={orgId ?? ALL}
      onValueChange={(v) => setOrgId(v === ALL ? undefined : v)}
    />
  );
}
