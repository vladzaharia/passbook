/** The shell worker's registration and removal. Kept apart from the stores, which import it on unpair. */
import { SCAN_SHELL_CACHE, SCAN_SW_PATH, SCAN_SW_SCOPE } from '../../../shared/scan-sw.ts';

export async function registerShell(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register(SCAN_SW_PATH, { scope: SCAN_SW_SCOPE });
  } catch (error) {
    // The shell then needs a connection to open; scanning itself is unaffected.
    void error;
  }
}

/** Unpair and revoke: drop the worker and its cache with the rest of the local data. */
export async function forgetShell(): Promise<void> {
  try {
    if ('serviceWorker' in navigator)
      await Promise.all(
        (await navigator.serviceWorker.getRegistrations()).map((r) => r.unregister()),
      );
    for (const name of await caches.keys())
      if (name.startsWith(SCAN_SHELL_CACHE)) await caches.delete(name);
  } catch (error) {
    // Nothing to forget if the browser has no worker or cache storage.
    void error;
  }
}
