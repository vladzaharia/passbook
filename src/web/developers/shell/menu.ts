/** Below 900 px the side nav is a drawer: the menu button opens it, Escape or a link closes it. */
export function initMenu(): void {
  const root = document.documentElement;
  const button = document.querySelector<HTMLButtonElement>('[data-menu-button]');
  if (!button) return;
  const set = (open: boolean) => {
    if (open) root.dataset.menu = 'open';
    else delete root.dataset.menu;
    button.setAttribute('aria-expanded', String(open));
  };
  button.addEventListener('click', () => set(root.dataset.menu !== 'open'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && root.dataset.menu === 'open') {
      set(false);
      button.focus();
    }
  });
  document.querySelector('#dev-menu')?.addEventListener('click', (e) => {
    if ((e.target as Element).closest('a')) set(false);
  });
}
