import { useNavigate } from '@tanstack/react-router';
import { Ticket } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ADMIN_NAV } from '../../lib/nav.ts';
import { useOrgFilter } from '../../lib/org-filter.tsx';
import { useOrgOptions, useRecentPassSearch } from '../../lib/search.ts';
import { type CommandGroup, CommandPalette } from '../command-palette.tsx';

/** Opens with Cmd/Ctrl+K. Navigation entries are local; passes come from the API. */
export function AdminPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const navigate = useNavigate();
  const { orgId } = useOrgFilter();
  const [query, setQuery] = useState('');
  const passes = useRecentPassSearch(open ? query : '', orgId);
  const orgs = useOrgOptions(open);
  const orgName = new Map((orgs.data?.items ?? []).map((o) => [o.id, o.name]));

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  const groups: CommandGroup[] = [
    {
      heading: 'Go to',
      items: ADMIN_NAV.map((item) => ({
        id: item.to,
        label: item.label,
        icon: item.icon,
        keywords: item.keywords,
        onSelect: () => void navigate({ to: item.to as never }),
      })),
    },
    {
      heading: 'Passes',
      items: (passes.data?.items ?? []).map((p) => ({
        id: p.id,
        label: p.title ?? p.serial,
        icon: Ticket,
        hint: [orgName.get(p.orgId), p.holderEmail ?? p.serial].filter(Boolean).join(' · '),
        remote: true,
        onSelect: () => void navigate({ to: `/admin/passes/${p.id}` as never }),
      })),
    },
  ];

  return (
    <CommandPalette
      open={open}
      onOpenChange={onOpenChange}
      groups={groups}
      query={query}
      onQueryChange={setQuery}
      placeholder="Search pages and passes"
    />
  );
}
