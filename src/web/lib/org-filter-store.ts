import { orgScopeSearchSchema } from './route-search.ts';

const KEY = 'wallet-org-filter';
const listeners = new Set<() => void>();

export function readRaw(): string | undefined {
  try {
    return localStorage.getItem(KEY) ?? undefined;
  } catch {
    // Storage may be blocked; the scope then lives in the URL only.
    return undefined;
  }
}

export function readStored(): string | undefined {
  return orgScopeSearchSchema.parse({ orgId: readRaw() }).orgId;
}

export function store(orgId: string | undefined): void {
  if (orgId === readRaw()) return;
  try {
    if (orgId) localStorage.setItem(KEY, orgId);
    else localStorage.removeItem(KEY);
  } catch {
    // See readRaw().
  }
  for (const listener of listeners) listener();
}

export const subscribe = (listener: () => void) => {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
};
