import { useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';
import { ConnectionListSchema } from '@/shared/contracts/connections.ts';
import type { OrgMembership } from '@/shared/contracts/org-membership.ts';
import { PassListSchema } from '@/shared/contracts/passes.ts';
import { TemplateListSchema } from '@/shared/contracts/templates.ts';
import { UserListSchema } from '@/shared/contracts/users.ts';
import { api } from './api.ts';
import { useOrgScope } from './org-filter.tsx';
import { membershipsQuery, useSession } from './session.ts';

const MIN_QUERY = 2;
/** Results per palette group. */
export const PALETTE_LIMIT = 5;

/** Palette and picker pass search is limited to the selected, authorized organization. */
export function useRecentPassSearch(q: string, orgId?: string) {
  const term = q.trim();
  const scope = useOrgScope();
  const { authed } = useSession();
  const selected = orgId ?? scope.orgId;
  const allowed = Boolean(
    selected && selected === scope.orgId && scope.membership?.capabilities.includes('passes:read'),
  );
  return useQuery({
    queryKey: ['palette', 'passes', authed?.user.id ?? null, term, allowed ? selected : null],
    queryFn: ({ signal }) => {
      if (!allowed || !selected) throw new Error('Choose an authorized organization.');
      return api.get('/api/v1/passes', PassListSchema, {
        query: { q: term, orgId: selected, limit: PALETTE_LIMIT },
        signal,
      });
    },
    enabled: allowed && term.length >= MIN_QUERY,
    staleTime: 15_000,
  });
}

/** Palette user search is available only to platform administrators. */
export function useUserSearch(q: string) {
  const term = q.trim();
  const { authed, isAdmin, isError, isFetching } = useSession();
  const allowed = isAdmin && !isError && !isFetching;
  return useQuery({
    queryKey: ['palette', 'users', allowed ? authed?.user.id : null, allowed ? term : ''],
    queryFn: ({ signal }) => {
      if (!allowed) throw new Error('Platform administrator access required.');
      return api.get('/api/v1/users', UserListSchema, {
        query: { q: term, limit: PALETTE_LIMIT },
        signal,
      });
    },
    enabled: allowed && term.length >= MIN_QUERY,
    staleTime: 15_000,
  });
}

// Memberships do not carry branding, so these options use the neutral avatar.
const neutralBranding: { accent?: string } = {};

/** Organization choices come from the caller's memberships, not the platform directory. */
export function useOrgOptions(enabled = true) {
  const { authed } = useSession();
  const scope = useOrgScope();
  const userId = authed?.user.id;
  const select = useCallback(
    ({ items }: { items: OrgMembership[] }) => ({
      items: items
        .filter((membership) => membership.userId === userId && membership.revokedAt === null)
        .map((membership) => ({
          id: membership.orgId,
          name: membership.orgName,
          slug: membership.orgSlug,
          status: 'active' as const,
          branding: neutralBranding,
        })),
    }),
    [userId],
  );
  const query = useQuery({ ...membershipsQuery, enabled: enabled && Boolean(userId), select });
  return query.isError || scope.isError || scope.isLoading ? { ...query, data: undefined } : query;
}

/** Palette and picker template search (server ?q=). */
export function useTemplateOptions(enabled: boolean, term = '') {
  const { orgId, membership } = useOrgScope();
  const { authed } = useSession();
  const allowed = Boolean(orgId && membership?.capabilities.includes('templates:read'));
  return useQuery({
    queryKey: ['palette', 'templates', authed?.user.id ?? null, term, allowed ? orgId : null],
    queryFn: ({ signal }) => {
      if (!allowed || !orgId) throw new Error('Choose an authorized organization.');
      return api.get('/api/v1/templates', TemplateListSchema, {
        query: { orgId, q: term || undefined, limit: PALETTE_LIMIT },
        signal,
      });
    },
    enabled: enabled && allowed,
    staleTime: 15_000,
  });
}

export function useConnectionOptions(enabled: boolean, term = '') {
  const { orgId, membership } = useOrgScope();
  const { authed } = useSession();
  const allowed = Boolean(orgId && membership?.capabilities.includes('integrations:read'));
  return useQuery({
    queryKey: ['palette', 'connections', authed?.user.id ?? null, term, allowed ? orgId : null],
    queryFn: ({ signal }) => {
      if (!allowed || !orgId) throw new Error('Choose an authorized organization.');
      return api.get('/api/v1/connections', ConnectionListSchema, {
        query: { orgId, q: term || undefined, limit: PALETTE_LIMIT },
        signal,
      });
    },
    enabled: enabled && allowed,
    staleTime: 15_000,
  });
}

/** Every word of the query appears in the text (case-insensitive). */
export function matchesWords(text: string, query: string): boolean {
  const hay = text.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}
