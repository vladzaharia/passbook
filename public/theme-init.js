// Blocking pre-paint script (external, so the CSP needs no inline allowance).
// Keep the storage key and values in sync with src/web/lib/theme.tsx.
(() => {
  try {
    const stored = localStorage.getItem('wallet-theme');
    const pref = stored === 'dark' || stored === 'light' ? stored : 'system';
    const root = document.documentElement;
    root.dataset.themePref = pref;
    if (pref === 'system') delete root.dataset.theme;
    else root.dataset.theme = pref;
  } catch {
    // Storage blocked: the system preference applies through CSS.
  }
})();
