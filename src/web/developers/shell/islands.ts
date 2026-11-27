import { disableZodCompiling } from '../model/jitless.ts';

export interface Island {
  mount(el: HTMLElement): void | Promise<void>;
}

/**
 * Placeholders the prerendered pages carry as `data-island="<name>"`, each a lazy chunk. Add a
 * loader here and the island mounts when its element nears the viewport. The static markup inside a
 * placeholder is its signed-out state.
 */
export const ISLANDS: Record<string, () => Promise<Island>> = {
  snippets: () => import('./personal.ts'),
  moved: async () => (await import('./moved.ts')).movedIsland,
  account: async () => {
    const { mountAccount } = await import('./account.ts');
    return { mount: async (el) => void (await mountAccount(el)) };
  },
  operations: async () => (await import('./operations.ts')).operationsIsland,
};

export function mountIslands(root: ParentNode = document): void {
  // Any island may load zod: its parser probe would log a Trusted Types violation (the account menu, the operations list).
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
            el.dataset.ready = '';
          }
        })();
      }
    },
    { rootMargin: '200px' },
  );
  for (const el of pending) observer.observe(el);
}
