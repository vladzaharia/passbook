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
  const byHash = (hash: string) => pairs.find(([, a]) => a.hash === hash)?.[1];
  // A chosen entry (a click, a hashchange, the hash on load) stays lit until the reader scrolls by hand.
  let pinned = byHash(location.hash);
  let lit: HTMLAnchorElement | undefined;
  const light = (next: HTMLAnchorElement | undefined) => {
    if (next === lit) return;
    lit?.removeAttribute('aria-current');
    next?.setAttribute('aria-current', 'location');
    lit = next;
  };
  const update = () => {
    if (pinned) return light(pinned);
    // The last section whose heading is above the line; the first one before any has passed.
    let next = pairs[0]?.[1];
    for (const [target, a] of pairs) if (target.getBoundingClientRect().top <= LINE) next = a;
    // At the foot of the page the last sections cannot reach the line: light the last one on screen.
    if (scrollY + innerHeight >= document.documentElement.scrollHeight - 2)
      for (const [target, a] of pairs)
        if (target.getBoundingClientRect().top < innerHeight) next = a;
    light(next);
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
  const free = () => {
    pinned = undefined;
  };
  nav.addEventListener('click', (e) => {
    const a = (e.target as Element).closest('a');
    if (a && pairs.some(([, p]) => p === a)) pinned = a;
    update();
  });
  addEventListener('hashchange', () => {
    pinned = byHash(location.hash) ?? pinned;
    update();
  });
  for (const type of ['wheel', 'touchmove', 'keydown'])
    addEventListener(type, free, { passive: true });
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', onScroll, { passive: true });
  update();
}
