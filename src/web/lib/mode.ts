import { useSyncExternalStore } from 'react';
import { MODE_HEADER, type Mode } from '@/shared/contracts/common.ts';
import { currentPath } from './current-path.ts';
import { parseAdminPath } from './scope.ts';

/** Per browser: Test mode stays on across reloads and tabs until it is turned off. */
export const MODE_KEY = 'passbook-mode';

function stored(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === 'test' ? 'test' : 'live';
  } catch {
    // Storage can be blocked (private mode); the tab starts live.
    return 'live';
  }
}

/** A tab opened with ?mode=test (or live) adopts it for this load; only a click is stored. */
function fromUrl(): Mode | null {
  if (typeof window === 'undefined') return null;
  const value = new URLSearchParams(window.location.search).get('mode');
  return value === 'test' || value === 'live' ? value : null;
}

const asked = fromUrl();
/** The mode this load's address switched to (`?mode=`), so the announcer says it once; null if it changed nothing. */
export const adoptedMode: Mode | null = asked !== null && asked !== stored() ? asked : null;
let current: Mode = asked ?? stored();
const listeners = new Set<(mode: Mode) => void>();

/** Platform pages ignore mode: they read and show Live whatever the browser's choice. */
const onPlatform = () => parseAdminPath(currentPath() ?? '').scope?.kind === 'platform';

/** Developer sandboxes never hold Live: they open, and stay, in Test whatever the browser chose. */
let testOnlyOrgs: ReadonlySet<string> = new Set();
const inTestOnlyOrg = () => {
  const scope = parseAdminPath(currentPath() ?? '').scope;
  return scope?.kind === 'org' && testOnlyOrgs.has(scope.orgId);
};

export const getMode = (): Mode =>
  onPlatform() ? 'live' : current === 'test' || inTestOnlyOrg() ? 'test' : 'live';

/**
 * Called with the signed-in person's organizations whenever they load. Listeners hear of it only
 * when the open page's mode changes: a grant that does not apply here must not empty the cache
 * under a page that is open (the Workbench's Console lost its response that way).
 */
export function setTestOnlyOrgs(orgIds: readonly string[]): void {
  if (orgIds.length === testOnlyOrgs.size && orgIds.every((id) => testOnlyOrgs.has(id))) return;
  const before = getMode();
  testOnlyOrgs = new Set(orgIds);
  const after = getMode();
  if (after !== before) for (const listener of listeners) listener(after);
}

function apply(next: Mode): void {
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener(next);
}

export function setMode(next: Mode): void {
  if (next === current) return;
  try {
    if (next === 'test') localStorage.setItem(MODE_KEY, 'test');
    else localStorage.removeItem(MODE_KEY);
  } catch {
    // Not saved; the choice still holds for this tab.
  }
  apply(next);
}

/** Runs after every change, including one made in another tab. Returns the unsubscribe. */
export function onModeChange(listener: (mode: Mode) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

if (typeof window !== 'undefined') {
  const adopted = fromUrl();
  if (adopted) {
    try {
      if (adopted === 'test') localStorage.setItem(MODE_KEY, 'test');
      else localStorage.removeItem(MODE_KEY);
    } catch {
      // Not saved; the choice still holds for this tab.
    }
  }
  window.addEventListener('storage', (event) => {
    if (event.key === MODE_KEY || event.key === null) apply(stored());
  });
}

export function useMode(): Mode {
  return useSyncExternalStore(onModeChange, getMode, () => 'live');
}

/** The header every admin API request carries while Test mode is on. */
export function modeHeaders(): Record<string, string> {
  return getMode() === 'test' ? { [MODE_HEADER]: 'test' } : {};
}

/** Test seam: back to live without touching storage listeners. */
export function resetModeForTests(): void {
  try {
    localStorage.removeItem(MODE_KEY);
  } catch {
    // Nothing stored.
  }
  apply('live');
}
