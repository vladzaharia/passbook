// Pointer tilt for the public pass page; same behaviour as PassCardStage in the app.
// Fine pointers only, and never with reduced motion. The page works without it.
(() => {
  const stage = document.querySelector('.pc-stage[data-tilt]');
  const card = stage?.querySelector('.pc-lift');
  if (!stage || !card) return;
  if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  let rect;
  let frame = 0;
  const clamp = (n) => Math.max(-0.5, Math.min(0.5, n));
  const set = (px, py) => {
    stage.style.setProperty('--px', px.toFixed(3));
    stage.style.setProperty('--py', py.toFixed(3));
  };
  card.addEventListener('pointerenter', () => {
    rect = card.getBoundingClientRect();
    stage.dataset.tracking = '';
  });
  card.addEventListener('pointermove', (e) => {
    rect ??= card.getBoundingClientRect();
    const px = clamp((e.clientX - rect.left) / rect.width - 0.5);
    const py = clamp((e.clientY - rect.top) / rect.height - 0.5);
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => set(px, py));
  });
  card.addEventListener('pointerleave', () => {
    cancelAnimationFrame(frame);
    rect = undefined;
    delete stage.dataset.tracking;
    set(0, 0);
  });
})();
