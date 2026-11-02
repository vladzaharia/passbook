import { useNavigate } from '@tanstack/react-router';
import { ArrowLeftRight, Plus, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useDebounced } from '@/web/lib/debounce.ts';
import { THEME_ICON } from '../../lib/action-icons.ts';
import { connectorIcon, ENTITY } from '../../lib/entities.ts';
import { ADMIN_NAV } from '../../lib/nav.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import {
  matchesWords,
  PALETTE_LIMIT,
  useConnectionOptions,
  useOrgOptions,
  useRecentPassSearch,
  useTemplateOptions,
  useUserSearch,
} from '../../lib/search.ts';
import { type ThemePref, useTheme } from '../../lib/theme.tsx';
import {
  type CommandGroup,
  type CommandItem,
  CommandPalette,
  matchLabel,
  PaletteItem,
} from '../command-palette.tsx';

/** Group headings and glyphs, from the entity registry. */
export const PALETTE_GROUPS = {
  passes: { heading: 'Passes', icon: ENTITY.pass.icon },
  templates: { heading: 'Templates', icon: ENTITY.template.icon },
  connections: { heading: 'Connections', icon: ENTITY.connection.icon },
  users: { heading: 'Users', icon: ENTITY.user.icon },
  orgs: { heading: 'Organizations', icon: ENTITY.org.icon },
} as const;

const THEMES: { value: ThemePref; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/**
 * Opens with Cmd/Ctrl+K. Pages and actions are local; passes and users search the server
 * (debounced 200 ms); templates, connections and orgs match one loaded page by name.
 */
/** Extra match terms: "new" lists every create action, Upload template included. */
const ACTION_KEYWORDS: Record<string, string[]> = {
  'new-pass': ['create', 'add'],
  'upload-template': ['new', 'create', 'add', 'import'],
  'new-connection': ['create', 'add'],
  'new-org': ['create', 'add', 'tenant'],
  'new-key': ['create', 'add'],
  'switch-org': ['organization', 'scope'],
};

export function AdminPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const navigate = useNavigate();
  const { orgId, setOrgId } = useOrgScope();
  const { setPref } = useTheme();
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'all' | 'orgs'>('all');
  const term = useDebounced(open ? query.trim() : '', 200);
  const passes = useRecentPassSearch(term, orgId);
  const users = useUserSearch(term);
  const orgs = useOrgOptions(open);
  const templates = useTemplateOptions(open && term.length > 0, term);
  const connections = useConnectionOptions(open && term.length > 0, term);
  const orgName = new Map((orgs.data?.items ?? []).map((o) => [o.id, o.name]));
  const go = (to: string, search?: Record<string, string>) => () =>
    void navigate({ to: to, ...(search ? { search: search } : {}) });

  useEffect(() => {
    if (!open) {
      setQuery('');
      setMode('all');
    }
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

  const q = query.trim();
  const local = (items: CommandItem[], keywords?: (i: CommandItem) => string[]) =>
    q ? items.filter((i) => matchLabel(i.label, q, keywords?.(i))) : items;
  const remote = term.length >= 2 && q.length >= 2;
  const named = <T extends { id: string; name: string }>(list: T[] | undefined) =>
    q ? (list ?? []).filter((x) => matchesWords(x.name, q)).slice(0, PALETTE_LIMIT) : [];

  const orgGroup: CommandItem[] = [
    {
      id: 'org:all',
      label: 'All orgs',
      icon: ENTITY.org.icon,
      onSelect: () => setOrgId(undefined),
    },
    ...(orgs.data?.items ?? []).map((o) => ({
      id: `org:${o.id}`,
      label: o.name,
      icon: ENTITY.org.icon,
      hint: o.id === orgId ? 'Current' : undefined,
      onSelect: () => setOrgId(o.id),
    })),
  ];

  const groups: CommandGroup[] =
    mode === 'orgs'
      ? [{ heading: 'Switch org', icon: ENTITY.org.icon, items: local(orgGroup) }]
      : [
          {
            heading: 'Pages',
            items: local(
              ADMIN_NAV.map((item) => ({
                id: item.to,
                label: item.label,
                icon: item.icon,
                onSelect: go(item.to),
              })),
              (i) => ADMIN_NAV.find((n) => n.to === i.id)?.keywords ?? [],
            ),
          },
          {
            ...PALETTE_GROUPS.passes,
            items: remote
              ? (passes.data?.items ?? []).map((p) => ({
                  id: `pass:${p.id}`,
                  label: p.title ?? p.serial,
                  icon: ENTITY.pass.icon,
                  hint: [orgName.get(p.orgId), p.holderEmail ?? p.serial]
                    .filter(Boolean)
                    .join(', '),
                  onSelect: go(`/admin/passes/${p.id}`),
                }))
              : [],
          },
          {
            ...PALETTE_GROUPS.templates,
            items: named(templates.data?.items).map((t) => ({
              id: `template:${t.id}`,
              label: t.name,
              icon: ENTITY.template.icon,
              hint: t.orgName ?? undefined,
              onSelect: go(`/admin/templates/${t.id}`),
            })),
          },
          {
            ...PALETTE_GROUPS.connections,
            items: named(connections.data?.items).map((c) => ({
              id: `connection:${c.id}`,
              label: c.name,
              icon: connectorIcon(c.connectorType),
              hint: orgName.get(c.orgId),
              onSelect: go(`/admin/connections/${c.id}`),
            })),
          },
          {
            ...PALETTE_GROUPS.users,
            items: remote
              ? (users.data?.items ?? []).map((u) => ({
                  id: `user:${u.id}`,
                  label: u.name ?? u.primaryEmail,
                  icon: ENTITY.user.icon,
                  hint: u.name ? u.primaryEmail : undefined,
                  onSelect: go(`/admin/users/${u.id}`),
                }))
              : [],
          },
          {
            ...PALETTE_GROUPS.orgs,
            items: named(orgs.data?.items).map((o) => ({
              id: `orgpage:${o.id}`,
              label: o.name,
              icon: ENTITY.org.icon,
              onSelect: go(`/admin/orgs/${o.id}`),
            })),
          },
          {
            heading: 'Actions',
            items: local(
              [
                {
                  id: 'new-pass',
                  label: 'New pass',
                  icon: Plus,
                  onSelect: go('/admin/passes/new'),
                },
                {
                  id: 'upload-template',
                  label: 'Upload template',
                  icon: Upload,
                  onSelect: go('/admin/templates/upload'),
                },
                {
                  id: 'new-connection',
                  label: 'New connection',
                  icon: Plus,
                  onSelect: go('/admin/connections/new'),
                },
                {
                  id: 'new-org',
                  label: 'New organization',
                  icon: Plus,
                  onSelect: go('/admin/orgs', { new: '1' }),
                },
                {
                  id: 'new-key',
                  label: 'New API key',
                  icon: Plus,
                  onSelect: go('/admin/api-keys', { new: '1' }),
                },
                {
                  id: 'switch-org',
                  label: 'Switch org…',
                  icon: ArrowLeftRight,
                  onSelect: () => {
                    setQuery('');
                    setMode('orgs');
                    onOpenChange(true);
                  },
                },
                ...THEMES.map((t) => ({
                  id: `theme:${t.value}`,
                  label: `Theme: ${t.label}`,
                  icon: THEME_ICON[t.value],
                  onSelect: () => setPref(t.value),
                })),
              ],
              (i) => ACTION_KEYWORDS[i.id] ?? (i.id.startsWith('theme') ? ['appearance'] : []),
            ),
          },
        ];

  const searchPasses: CommandItem = {
    id: 'search-passes',
    label: `Search passes for "${q}"`,
    icon: ENTITY.search.icon,
    onSelect: go('/admin/passes', { q }),
  };

  return (
    <CommandPalette
      open={open}
      onOpenChange={onOpenChange}
      groups={groups}
      query={query}
      onQueryChange={setQuery}
      placeholder={mode === 'orgs' ? 'Find an organization' : 'Search pages and passes'}
      empty={
        mode === 'all' ? (
          <PaletteItem item={searchPasses} close={() => onOpenChange(false)} />
        ) : null
      }
    />
  );
}
