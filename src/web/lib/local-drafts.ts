/** Where the designer keeps unsaved drafts. Sign-out removes them so the next person never sees them. */
export const DRAFT_PREFIX = 'passbook:designer:';

export function clearLocalDrafts(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(DRAFT_PREFIX)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    // Storage blocked: there are no drafts to remove.
  }
}
