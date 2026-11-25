/** "On this page": the entry for the section being read is lit (aria-current="location"). */
const LINE = 120;

export function initToc(): void {
  const nav = document.querySelector<HTMLElement>('[data-toc]');
  if (!nav) return;
  const pairs: [HTMLElement, HTMLAnchorElement][] = [];
  for (const a of nav.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')) {
    const target = document.getElementById(decodeURIComponent(a.hash.slice(1)));
    if (target) pairs.push([target, a]);
  }
  if (pairs.length === 0) return;
  let lit: HTMLAnchorElement | undefined;
  const update = () => {
    // The last section whose heading is above the line; the first one before any has passed.
    let next = pairs[0]?.[1];
    for (const [target, a] of pairs) if (target.getBoundingClientRect().top <= LINE) next = a;
    if (next === lit) return;
    lit?.removeAttribute('aria-current');
    next?.setAttribute('aria-current', 'location');
    lit = next;
  };
  let queued = false;
  const onScroll = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      update();
    });
  };
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', onScroll, { passive: true });
  update();
}
