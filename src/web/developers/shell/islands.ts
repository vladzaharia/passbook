export interface Island {
  mount(el: HTMLElement): void;
}

/**
 * Placeholders the prerendered pages carry as `data-island="<name>"`, each a lazy chunk. Add a
 * loader here and the island mounts when its element nears the viewport. The static markup inside a
 * placeholder is its signed-out state.
 */
export const ISLANDS: Record<string, () => Promise<Island>> = {
  playground: () => import('../playground/index.tsx'),
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
        void ISLANDS[el.dataset.island ?? '']?.().then((island) => island.mount(el));
      }
    },
    { rootMargin: '200px' },
  );
  for (const el of pending) observer.observe(el);
}
