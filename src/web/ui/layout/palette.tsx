import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { RefreshCw, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PlatformOrgListSchema } from '@/web/admin/orgs/queries.ts';
import { useDebounced } from '@/web/lib/debounce.ts';
import { api } from '../../lib/api.ts';
import { connectorIcon, ENTITY } from '../../lib/entities.ts';
import { canAccessAdminPath } from '../../lib/guards.ts';
import { adminNavGroups, isOrgScoped } from '../../lib/nav.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import {
  matchesWords,
  PALETTE_LIMIT,
  useConnectionOptions,
  useRecentPassSearch,
  useTemplateOptions,
  useUserSearch,
} from '../../lib/search.ts';
import { useSession } from '../../lib/session.ts';
import { useSwatches } from '../../lib/swatches.ts';
import { useTheme } from '../../lib/theme.tsx';
import {
  type CommandGroup,
  type CommandItem,
  CommandPalette,
  matchLabel,
  PaletteItem,
} from '../command-palette.tsx';
import { paletteActions } from './palette-actions.ts';
import { ACTION_KEYWORDS, chip } from './palette-helpers.ts';

/** Group headings and glyphs, from the entity registry. */
export const PALETTE_GROUPS = {
  passes: { heading: 'Passes', icon: ENTITY.pass.icon },
  templates: { heading: 'Templates', icon: ENTITY.template.icon },
  connections: { heading: 'Connections', icon: ENTITY.connection.icon },
  users: { heading: 'Users', icon: ENTITY.user.icon },
  orgs: { heading: 'Organizations', icon: ENTITY.org.icon },
} as const;

/** Pages and actions are local; tenant searches use the selected membership. */
export function AdminPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const navigate = useNavigate();
  const scope = useOrgScope();
  const { isAdmin, isFetching: sessionFetching, isError: sessionError, authed } = useSession();
  const platformReady = isAdmin && !sessionFetching && !sessionError;
  const ready = !scope.isLoading && !scope.isError;
  const memberships = ready ? scope.memberships : [];
  const membership = ready ? scope.membership : undefined;
  const orgId = membership?.orgId;
  const { setOrgId } = scope;
  const { setPref } = useTheme();
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'all' | 'orgs'>('all');
  const term = useDebounced(open ? query.trim() : '', 200);
  const searching = open && mode === 'all';
  const canPasses = canAccessAdminPath('/admin/passes', isAdmin, membership);
  const canTemplates = canAccessAdminPath('/admin/templates', isAdmin, membership);
  const canConnections = canAccessAdminPath('/admin/connections', isAdmin, membership);
  const passes = useRecentPassSearch(searching && canPasses ? term : '', orgId);
  const passItems =
    searching && canPasses && orgId
      ? (passes.data?.items ?? []).filter((pass) => pass.orgId === orgId)
      : [];
  const swatches = useSwatches(
    canTemplates ? [...new Set(passItems.map((pass) => pass.templateId))] : [],
    orgId,
  );
  const users = useUserSearch(searching && platformReady ? term : '');
  const templates = useTemplateOptions(searching && canTemplates && term.length > 0, term);
  const connections = useConnectionOptions(searching && canConnections && term.length > 0, term);
  // Directory search is a platform action, separate from membership-only scope selection.
  const directory = useQuery({
    queryKey: ['palette', 'org-directory', authed?.user.id, term],
    queryFn: ({ signal }) =>
      api.get('/api/v1/orgs', PlatformOrgListSchema, {
        query: { q: term, limit: PALETTE_LIMIT },
        signal,
      }),
    enabled: searching && platformReady && term.length >= 2,
    staleTime: 15_000,
  });
  const nav = adminNavGroups(platformReady, membership).flat();
  const orgName = new Map(memberships.map((item) => [item.orgId, item.orgName]));
  const go = (to: string, search?: Record<string, string>) => () =>
    void navigate({
      to,
      search: { ...search, orgId: search?.orgId ?? (isOrgScoped(to) ? orgId : undefined) },
    });

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

  const orgGroup: CommandItem[] = scope.isError
    ? [
        {
          id: 'retry-org-access',
          label: 'Retry organization access',
          icon: RefreshCw,
          onSelect: () => void scope.refetch(),
        },
      ]
    : memberships.map((item) => ({
        id: `org:${item.orgId}`,
        label: item.orgName,
        icon: ENTITY.org.icon,
        hint: item.orgId === orgId ? 'Current' : undefined,
        onSelect: () => setOrgId(item.orgId),
      }));
  const orgResults: { id: string; name: string }[] = platformReady
    ? (directory.data?.items ?? []).map(({ id, name }) => ({ id, name }))
    : !isAdmin &&
        membership &&
        canAccessAdminPath(
          `/admin/orgs/${encodeURIComponent(membership.orgId)}`,
          false,
          membership,
          'workspace',
        )
      ? [{ id: membership.orgId, name: membership.orgName }]
      : [];

  const groups: CommandGroup[] =
    mode === 'orgs'
      ? [{ heading: 'Switch organization', icon: ENTITY.org.icon, items: local(orgGroup) }]
      : [
          {
            heading: 'Pages',
            items: local(
              nav.map((item) => ({
                id: item.to,
                label: item.label,
                icon: item.icon,
                onSelect: go(item.to, item.search),
              })),
              (i) => nav.find((n) => n.to === i.id)?.keywords ?? [],
            ),
          },
          {
            ...PALETTE_GROUPS.passes,
            items:
              remote && canPasses
                ? passItems.map((p) => ({
                    id: `pass:${p.id}`,
                    label: p.title ?? p.serial,
                    ...chip(swatches.get(p.templateId)),
                    hint: [orgName.get(p.orgId), p.holderEmail ?? p.serial]
                      .filter(Boolean)
                      .join(', '),
                    onSelect: go(`/admin/passes/${p.id}`),
                  }))
                : [],
          },
          {
            ...PALETTE_GROUPS.templates,
            items: named(canTemplates ? templates.data?.items : []).map((t) => ({
              id: `template:${t.id}`,
              label: t.name,
              icon: ENTITY.template.icon,
              hint: t.orgName ?? undefined,
              onSelect: go(`/admin/templates/${t.id}`),
            })),
          },
          {
            ...PALETTE_GROUPS.connections,
            items: named(
              canConnections ? connections.data?.items.filter((c) => c.orgId === orgId) : [],
            ).map((c) => ({
              id: `connection:${c.id}`,
              label: c.name,
              icon: connectorIcon(c.connectorType),
              hint: orgName.get(c.orgId),
              onSelect: go(`/admin/connections/${c.id}`),
            })),
          },
          {
            ...PALETTE_GROUPS.users,
            items:
              remote && platformReady
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
            items: named(orgResults).map((o) => ({
              id: `orgpage:${o.id}`,
              label: o.name,
              icon: ENTITY.org.icon,
              onSelect: go(
                `/admin/orgs/${encodeURIComponent(o.id)}`,
                isAdmin ? undefined : { view: 'workspace', orgId: o.id },
              ),
            })),
          },
          {
            heading: 'Actions',
            items: local(
              paletteActions({
                isAdmin,
                platformReady,
                membership,
                hasMemberships: memberships.length > 0,
                scopeError: scope.isError,
                go,
                onSwitchOrg: () => {
                  setQuery('');
                  setMode('orgs');
                  onOpenChange(true);
                },
                onRetry: () => void scope.refetch(),
                setPref,
              }),
              (i) => ACTION_KEYWORDS[i.id] ?? (i.id.startsWith('theme') ? ['appearance'] : []),
            ),
          },
        ];

  const searchPasses: CommandItem = {
    id: 'search-passes',
    label: `Search passes for "${q}"`,
    icon: Search,
    onSelect: go('/admin/passes', { q }),
  };

  return (
    <CommandPalette
      open={open}
      onOpenChange={onOpenChange}
      groups={groups}
      query={query}
      onQueryChange={setQuery}
      placeholder={mode === 'orgs' ? 'Find an organization' : 'Search'}
      empty={
        mode === 'all' && canPasses && orgId ? (
          <PaletteItem item={searchPasses} close={() => onOpenChange(false)} />
        ) : null
      }
    />
  );
}
