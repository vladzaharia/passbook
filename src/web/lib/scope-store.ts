import { useMemo, useSyncExternalStore } from 'react';
import { type AdminScope, parseScopeKey, scopeKey } from './scope.ts';

// The last scope opened. It answers /admin and legacy links that name no scope; it never
// rewrites a URL that names one, and it grants nothing (the scope gates check membership).
const KEY = 'passbook-admin-scope';
const LEGACY_KEY = 'wallet-org-filter';

function read(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    // Storage may be blocked; /admin then picks a scope from the grants alone.
    return undefined;
  }
}

export function readRemembered(): AdminScope | undefined {
  const legacy = read(LEGACY_KEY);
  return (
    parseScopeKey(read(KEY)) ??
    (legacy && legacy.length <= 100 ? { kind: 'org', orgId: legacy } : undefined)
  );
}

const listeners = new Set<() => void>();

export function remember(scope: AdminScope | undefined): void {
  try {
    if (scope) localStorage.setItem(KEY, scopeKey(scope));
    else localStorage.removeItem(KEY);
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    // See read().
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab opening a scope changes what this tab remembers too.
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

/** The remembered scope, kept current when this or another tab opens one. */
export function useRememberedScope(): AdminScope | undefined {
  const raw = useSyncExternalStore(
    subscribe,
    () => `${read(KEY) ?? ''}|${read(LEGACY_KEY) ?? ''}`,
    () => '|',
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: raw is the storage snapshot.
  return useMemo(() => readRemembered(), [raw]);
}

// This tab's open scope, for legacy in-app links: storage is shared by every tab.
let tabScope: AdminScope | undefined;

export const readTabScope = (): AdminScope | undefined => tabScope;

/** The scope gates call this once membership (or platform rights) is confirmed. */
export function enterScope(scope: AdminScope): void {
  tabScope = scope;
  remember(scope);
}

/** Test seam: a new tab. */
export function resetTabScope(): void {
  tabScope = undefined;
}
