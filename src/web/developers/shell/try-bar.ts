import { PHONE } from '../../workbench/console/phone.ts';

/**
 * The phone's sticky "Try it" bar points at the operation on screen and, on a phone, opens that
 * operation's console as a sheet. Elsewhere it is a link to the slot.
 */
export function initTryBar(): void {
  const link = document.querySelector<HTMLAnchorElement>('[data-try-bar]');
  const slots = [...document.querySelectorAll<HTMLElement>('.op .try')];
  if (!link || slots.length === 0 || !('IntersectionObserver' in window)) return;
  const ops = slots.map((s) => s.closest('.op') as HTMLElement);
  const seen = new Set<Element>();
  let current: HTMLElement | undefined = slots[0];
  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) seen.add(e.target);
      else seen.delete(e.target);
    }
    const top = ops.find((op) => seen.has(op));
    const slot = top?.querySelector<HTMLElement>('.try');
    if (slot?.id) {
      link.setAttribute('href', `#${slot.id}`);
      current = slot;
    }
  });
  for (const op of ops) observer.observe(op);
  link.addEventListener('click', (e) => {
    if (!current || !matchMedia(PHONE).matches) return;
    e.preventDefault();
    void import('./sheet.ts').then((m) => m.openSheet(current as HTMLElement));
  });
}
