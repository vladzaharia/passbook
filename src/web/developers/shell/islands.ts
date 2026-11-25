import { disableZodCompiling } from '../playground/jitless.ts';

export interface Island {
  mount(el: HTMLElement): void | Promise<void>;
}

/**
 * Placeholders the prerendered pages carry as `data-island="<name>"`, each a lazy chunk. Add a
 * loader here and the island mounts when its element nears the viewport. The static markup inside a
 * placeholder is its signed-out state.
 */
export const ISLANDS: Record<string, () => Promise<Island>> = {
  'webhook-tester': () => import('../webhooks/index.tsx'),
  snippets: () => import('./personal.ts'),
  moved: async () => (await import('./moved.ts')).movedIsland,
  playground: () => import('../playground/index.tsx'),
  quickstart: () => import('../quickstart/index.tsx'),
  workbench: () => import('../workbench/index.tsx'),
  keys: () => import('../keys/index.tsx'),
  run: () => import('../console/run-entry.ts'),
  account: async () => {
    const { mountAccount } = await import('./account.ts');
    return { mount: async (el) => void (await mountAccount(el)) };
  },
  'org-chip': async () => {
    const { mountOrgChip } = await import('../console/org-chip.ts');
    return { mount: mountOrgChip };
  },
  logs: async () => (await import('../logs/entry.ts')).logsIsland,
  'api-rail': async () => (await import('../logs/entry.ts')).railIsland,
};

/**
 * `account` and `workbench` hold from the first paint in CSS (dev-run.css) until `data-ready`: the prerender cannot
 * know the session, and a signed-in page must not show the signed-out markup first.
 */
const HOLD_UNTIL_MOUNTED = (el: HTMLElement) =>
  el.dataset.island === 'quickstart' ||
  el.dataset.island === 'logs' ||
  (el.dataset.island === 'run' && el.dataset.mode === 'console');

export function mountIslands(root: ParentNode = document): void {
  // Any island may load zod: its parser probe would log a Trusted Types violation (keys, webhooks, logs, console).
  disableZodCompiling();
  const pending = [...root.querySelectorAll<HTMLElement>('[data-island]')].filter(
    (el) => el.dataset.island && ISLANDS[el.dataset.island],
  );
  if (pending.length === 0) return;
  if (!('IntersectionObserver' in window)) {
    for (const el of pending) el.dataset.ready = '';
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        const el = entry.target as HTMLElement;
        void (async () => {
          try {
            const island = await ISLANDS[el.dataset.island ?? '']?.();
            await island?.mount(el);
          } catch (error) {
            // Not silent, and not an unhandled rejection: the page's error handler gets it.
            reportError(error);
          } finally {
            // Mounted or not, the static markup shows again if the island never replaced it.
            delete el.dataset.hydrating;
            el.dataset.ready = '';
          }
        })();
      }
    },
    { rootMargin: '200px' },
  );
  for (const el of pending) {
    // The static markup reads signed out: hide it until the session is known, so a signed-in page never flashes it.
    if (HOLD_UNTIL_MOUNTED(el)) el.dataset.hydrating = '';
    observer.observe(el);
  }
}
