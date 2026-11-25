/** Brings the lit entry of the tree into view inside its own scroll box (the page does not move). */
export function revealCurrent(nav: HTMLElement): void {
  const current = nav.querySelector<HTMLElement>('a[aria-current="page"]:not(.menu-sections a)');
  if (!current || nav.getClientRects().length === 0) return;
  const top = current.getBoundingClientRect().top - nav.getBoundingClientRect().top + nav.scrollTop;
  nav.scrollTop = Math.max(0, top - nav.clientHeight / 2);
}

/** Below 1181 px the tree is a sheet: the menu button opens it, Escape or a link closes it. */
export function initMenu(): void {
  const root = document.documentElement;
  const nav = document.querySelector<HTMLElement>('#dev-menu');
  if (nav) revealCurrent(nav);
  const button = document.querySelector<HTMLButtonElement>('[data-menu-button]');
  if (!button) return;
  // The sheet is modal: what is behind it can be neither reached nor read while it is open.
  const behind = () => document.querySelectorAll<HTMLElement>('main, footer.foot');
  const set = (open: boolean) => {
    const was = root.dataset.menu === 'open';
    if (open) root.dataset.menu = 'open';
    else delete root.dataset.menu;
    button.setAttribute('aria-expanded', String(open));
    for (const el of behind()) el.inert = open;
    if (open && nav) {
      revealCurrent(nav);
      const first = nav.querySelector<HTMLElement>('a[aria-current="page"]:not(.menu-sections a)');
      (first ?? nav.querySelector<HTMLElement>('a'))?.focus({ preventScroll: true });
    } else if (was) button.focus();
  };
  button.addEventListener('click', () => set(root.dataset.menu !== 'open'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && root.dataset.menu === 'open') set(false);
  });
  document.querySelector('#dev-menu')?.addEventListener('click', (e) => {
    if ((e.target as Element).closest('a')) set(false);
  });
}
