// Kept apart from the page so the route's search validator stays out of the entry chunk.
export interface InboxSearch {
  email?: string | undefined;
}

export const parseInboxSearch = (raw: Record<string, unknown>): InboxSearch => ({
  email: typeof raw.email === 'string' && raw.email.trim() ? raw.email.trim() : undefined,
});
