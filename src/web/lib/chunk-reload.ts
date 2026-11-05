/**
 * A deploy replaces hashed chunks; reload once to pick up the new shell. Offline, a reload would
 * lose the shell: the route shows "Could not load this page" with Reload instead (RouteError).
 * Shared by the SPA and /scan.
 */
export function installChunkReload(): void {
  window.addEventListener('vite:preloadError', (event) => {
    if (!navigator.onLine) return;
    event.preventDefault();
    try {
      if (sessionStorage.getItem('chunk-reload')) return;
      sessionStorage.setItem('chunk-reload', '1');
    } catch {
      return;
    }
    window.location.reload();
  });

  window.setTimeout(() => {
    try {
      sessionStorage.removeItem('chunk-reload');
    } catch {
      // Storage blocked; nothing to clear.
    }
  }, 10_000);
}
