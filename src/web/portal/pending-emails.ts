import { useCallback, useState } from 'react';

const KEY = 'wallet-pending-emails';

function read(): string[] {
  try {
    const raw = sessionStorage.getItem(KEY);
    const value: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    // Storage blocked or garbled: no pending rows, the add field still works.
    return [];
  }
}

function write(list: string[]): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Storage blocked: the pending row lives until reload.
  }
}

/**
 * Addresses waiting for their verification link, kept in this tab only: the API never says
 * whether an address is pending (that would reveal who is registered).
 */
export function usePendingEmails() {
  const [list, setList] = useState<string[]>(read);
  const add = useCallback((email: string) => {
    setList((prev) => {
      const next = prev.includes(email) ? prev : [...prev, email];
      write(next);
      return next;
    });
  }, []);
  const drop = useCallback((emails: readonly string[]) => {
    setList((prev) => {
      const next = prev.filter((e) => !emails.includes(e));
      write(next);
      return next;
    });
  }, []);
  return { list, add, drop };
}
