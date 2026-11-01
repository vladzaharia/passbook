// Theme toggle for Worker-rendered pages. Keep the storage key in sync with src/web/lib/theme.tsx.
(() => {
  const button = document.getElementById('theme-toggle');
  if (!button) return;
  const order = ['system', 'light', 'dark'];
  const root = document.documentElement;
  const apply = (pref) => {
    root.dataset.themePref = pref;
    if (pref === 'system') delete root.dataset.theme;
    else root.dataset.theme = pref;
    button.setAttribute('aria-label', `Theme: ${pref[0].toUpperCase()}${pref.slice(1)}`);
  };
  let current = order.includes(root.dataset.themePref) ? root.dataset.themePref : 'system';
  apply(current);
  button.addEventListener('click', () => {
    current = order[(order.indexOf(current) + 1) % order.length];
    try {
      if (current === 'system') localStorage.removeItem('wallet-theme');
      else localStorage.setItem('wallet-theme', current);
    } catch {
      // Storage blocked: the choice lasts for this page only.
    }
    apply(current);
  });
})();
