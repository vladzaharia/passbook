export interface UsersSearch {
  q?: string | undefined;
  status?: 'active' | 'disabled' | undefined;
}

export function parseUsersSearch(raw: Record<string, unknown>): UsersSearch {
  const q = typeof raw.q === 'string' && raw.q.trim() ? raw.q.trim() : undefined;
  const status = raw.status === 'active' || raw.status === 'disabled' ? raw.status : undefined;
  return { q, status };
}
