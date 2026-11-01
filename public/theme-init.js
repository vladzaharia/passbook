// Blocking pre-paint script (external, so the CSP needs no inline allowance).
// Keep the storage key and values in sync with src/web/lib/theme.tsx. The stored choice applies
// to the admin console only; holder pages follow the system appearance.
(() => {
  try {
    const path = location.pathname;
    const admin = path === '/admin' || path.startsWith('/admin/');
    const stored = admin ? localStorage.getItem('wallet-theme') : null;
    const pref = stored === 'dark' || stored === 'light' ? stored : 'system';
    const root = document.documentElement;
    root.dataset.themePref = pref;
    if (pref === 'system') delete root.dataset.theme;
    else root.dataset.theme = pref;
  } catch {
    // Storage blocked: the system preference applies through CSS.
  }
})();
