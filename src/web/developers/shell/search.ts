const typing = (el: EventTarget | null) =>
  el instanceof HTMLElement &&
  (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

/**
 * ⌘K or Ctrl+K opens search from any page, and so does "/" outside a field and any
 * `[data-search]` button. The palette, its kit pieces and the index are one lazy chunk; this stays
 * a few lines in the initial load.
 */
export function initSearch(): void {
  let loading: Promise<typeof import('../search/palette-island.tsx')> | null = null;
  const load = () => {
    loading ??= import('../search/palette-island.tsx');
    return loading;
  };
  const open = () => void load().then((m) => m.toggleSearch());
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      open();
    } else if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !typing(e.target)) {
      e.preventDefault();
      open();
    }
  });
  for (const el of document.querySelectorAll<HTMLElement>('[data-search]')) {
    el.addEventListener('click', open);
    // The chunk is small; start it when the pointer or focus gets near.
    el.addEventListener('pointerenter', () => void load(), { once: true });
    el.addEventListener('focus', () => void load(), { once: true });
  }
}
