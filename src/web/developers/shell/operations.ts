import type { Island } from './islands.ts';

/**
 * The `operations` island in the bar's `controls` slot: the shared activity tray for a signed-in
 * reader. The prerender holds an empty span, and signed out nothing loads: the tray, its sheet and
 * the progress panel are one lazy chunk (operations-island.tsx).
 */
export const operationsIsland: Island = {
  async mount(el) {
    let csrf: string | undefined;
    try {
      const res = await fetch('/api/v1/session', {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      });
      const body = res.ok
        ? ((await res.json()) as { authenticated?: boolean; csrfToken?: string })
        : null;
      if (!body?.authenticated || !body.csrfToken) return;
      csrf = body.csrfToken;
    } catch {
      // Offline or blocked: no tray until the next page.
      return;
    }
    const token = csrf;
    const { mountTray } = await import('./operations-island.tsx');
    mountTray(el, token);
  },
};
