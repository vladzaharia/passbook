import type { Island } from './islands.ts';

/**
 * A resource page used to hold every operation, linked as `#create` or `#passes.postPasses`. Each
 * operation has its own page now: a link with an old fragment lands on its row, and this follows it.
 */
export const movedIsland: Island = {
  mount() {
    const hash = decodeURIComponent(location.hash.slice(1));
    if (!hash) return;
    const rows = [...document.querySelectorAll<HTMLAnchorElement>('a[data-moved]')];
    const row = rows.find((a) => a.id === hash || a.dataset.alias === hash);
    if (row) location.replace(row.href);
  },
};
