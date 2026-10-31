(() => {
  try {
    const pref = localStorage.getItem('wallet-theme') || 'system';
    if (pref === 'dark' || pref === 'light') document.documentElement.dataset.theme = pref;
  } catch {}
})();
