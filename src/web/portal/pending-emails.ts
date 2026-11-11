import { useCallback, useEffect, useState } from 'react';

const LEGACY_KEY = 'wallet-pending-emails';
const keyFor = (userId: string) => `${LEGACY_KEY}:${userId}`;

function read(userId: string | undefined): string[] {
  if (!userId) return [];
  try {
    const raw = sessionStorage.getItem(keyFor(userId));
    const value: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    // Storage blocked or garbled: no pending rows, the add field still works.
    return [];
  }
}

function write(userId: string, list: string[]): void {
  try {
    sessionStorage.setItem(keyFor(userId), JSON.stringify(list));
  } catch {
    // Storage blocked: the pending row lives until reload.
  }
}

type PendingState = { userId: string | undefined; list: string[] };

/**
 * Addresses waiting for their verification link, kept in this tab and scoped to the signed-in
 * user: the API never says whether an address is pending (that would reveal who is registered).
 */
export function usePendingEmails(userId: string | undefined) {
  const [state, setState] = useState<PendingState>(() => ({ userId, list: read(userId) }));

  // The old key has no owner, so its contents cannot safely be attributed to any account.
  useEffect(() => {
    try {
      sessionStorage.removeItem(LEGACY_KEY);
    } catch {
      // Storage may be blocked.
    }
  }, []);

  // Reset during render so no frame can display the previous principal's pending addresses.
  if (state.userId !== userId) setState({ userId, list: read(userId) });

  const add = useCallback(
    (email: string) => {
      if (!userId) return;
      setState((prev) => {
        if (prev.userId !== userId) return prev;
        const list = prev.list.includes(email) ? prev.list : [...prev.list, email];
        write(userId, list);
        return { userId, list };
      });
    },
    [userId],
  );
  const drop = useCallback(
    (emails: readonly string[]) => {
      if (!userId) return;
      setState((prev) => {
        if (prev.userId !== userId) return prev;
        const list = prev.list.filter((email) => !emails.includes(email));
        write(userId, list);
        return { userId, list };
      });
    },
    [userId],
  );
  return { list: state.userId === userId ? state.list : [], add, drop };
}
