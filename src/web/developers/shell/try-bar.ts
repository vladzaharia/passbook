/** The phone's sticky "Try it" bar points at the operation on screen. */
export function initTryBar(): void {
  const link = document.querySelector<HTMLAnchorElement>('[data-try-bar]');
  const slots = [...document.querySelectorAll<HTMLElement>('.op .try')];
  if (!link || slots.length === 0 || !('IntersectionObserver' in window)) return;
  const ops = slots.map((s) => s.closest('.op') as HTMLElement);
  const seen = new Set<Element>();
  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) seen.add(e.target);
      else seen.delete(e.target);
    }
    const top = ops.find((op) => seen.has(op));
    const slot = top?.querySelector('.try');
    if (slot?.id) link.setAttribute('href', `#${slot.id}`);
  });
  for (const op of ops) observer.observe(op);
}
