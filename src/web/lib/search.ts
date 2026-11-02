import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ConnectionListSchema } from '@/shared/contracts/connections.ts';
import { OrgListSchema } from '@/shared/contracts/orgs.ts';
import { PassListSchema } from '@/shared/contracts/passes.ts';
import { TemplateListSchema } from '@/shared/contracts/templates.ts';
import { UserListSchema } from '@/shared/contracts/users.ts';
import { api } from './api.ts';

const MIN_QUERY = 2;
/** Results per palette group. */
export const PALETTE_LIMIT = 5;

/** Palette pass search (server ?q=). Disabled until the query has 2+ characters. */
export function useRecentPassSearch(q: string, orgId?: string) {
  const term = q.trim();
  return useQuery({
    queryKey: ['palette', 'passes', term, orgId ?? null],
    queryFn: ({ signal }) =>
      api.get('/api/v1/passes', PassListSchema, {
        query: { q: term, orgId, limit: PALETTE_LIMIT },
        signal,
      }),
    enabled: term.length >= MIN_QUERY,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}

/** Palette user search (server ?q=). */
export function useUserSearch(q: string) {
  const term = q.trim();
  return useQuery({
    queryKey: ['palette', 'users', term],
    queryFn: ({ signal }) =>
      api.get('/api/v1/users', UserListSchema, {
        query: { q: term, limit: PALETTE_LIMIT },
        signal,
      }),
    enabled: term.length >= MIN_QUERY,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}

export function useOrgOptions(enabled = true) {
  return useQuery({
    queryKey: ['orgs', 'options'],
    queryFn: ({ signal }) =>
      api.get('/api/v1/orgs', OrgListSchema, { query: { limit: 200 }, signal }),
    enabled,
    staleTime: 60_000,
  });
}

/** Templates and connections have no ?q=; the palette loads one page and matches names locally. */
export function useTemplateOptions(enabled: boolean) {
  return useQuery({
    queryKey: ['palette', 'templates'],
    queryFn: ({ signal }) =>
      api.get('/api/v1/templates', TemplateListSchema, { query: { limit: 200 }, signal }),
    enabled,
    staleTime: 60_000,
  });
}

export function useConnectionOptions(enabled: boolean) {
  return useQuery({
    queryKey: ['palette', 'connections'],
    queryFn: ({ signal }) =>
      api.get('/api/v1/connections', ConnectionListSchema, { query: { limit: 200 }, signal }),
    enabled,
    staleTime: 60_000,
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
