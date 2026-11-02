// Click to replay the mascot's scene on the auth and error pages; the app does the same in
// src/web/ui/art/replay.ts. The click stops at the art, which is decorative. Reduced motion: a
// click does nothing. The page works without it.
(() => {
  for (const host of document.querySelectorAll('[data-replay]')) {
    host.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      // Off, a style flush, on: the scene restarts with no frame painted between.
      host.removeAttribute('data-run');
      host.getBoundingClientRect();
      host.setAttribute('data-run', '');
    });
  }
})();
