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

export function mountIslands(root: ParentNode = document): void {
  const pending = [...root.querySelectorAll<HTMLElement>('[data-island]')].filter(
    (el) => el.dataset.island && ISLANDS[el.dataset.island],
  );
  if (pending.length === 0 || !('IntersectionObserver' in window)) return;
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
          } finally {
            // Mounted or not, the static Sign in shows again if the island never replaced it.
            delete el.dataset.hydrating;
          }
        })();
      }
    },
    { rootMargin: '200px' },
  );
  for (const el of pending) {
    // The account slot is Sign in until the session is known: hide it meanwhile, so a signed-in page never shows both.
    if (el.dataset.island === 'account') el.dataset.hydrating = '';
    observer.observe(el);
  }
}
