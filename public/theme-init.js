// Blocking pre-paint script (external, so the CSP needs no inline allowance). Every path: the
// wallet-theme cookie, else the value stored before the cookie existed, else the system.
// Mirrors readPref and applyPref in src/web/lib/theme.tsx (theme.test.ts checks they agree).
(() => {
  const valid = (v) => v === 'system' || v === 'light' || v === 'dark';
  const match = /(?:^|;\s*)wallet-theme=([^;]*)/.exec(document.cookie);
  let pref = match ? match[1] : null;
  if (!valid(pref)) {
    try {
      pref = localStorage.getItem('wallet-theme');
    } catch {
      // Storage blocked: the system preference applies through CSS.
      pref = null;
    }
  }
  if (!valid(pref)) pref = 'system';
  const root = document.documentElement;
  root.dataset.themePref = pref;
  if (pref === 'system') delete root.dataset.theme;
  else root.dataset.theme = pref;
})();
