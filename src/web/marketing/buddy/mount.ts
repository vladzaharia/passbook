import { trustedHtml } from '../trusted-html.ts';
import { draw } from './body.ts';
import { DEFS } from './defs.ts';
import { demo } from './demo.ts';
import { scene } from './scenes.ts';

/** Acts play when an element enters view and pause off screen; without the observer they just play. */
let io: IntersectionObserver | null = null;

function watch(elm: Element) {
  if (!io) {
    elm.classList.add('in');
    return;
  }
  io.observe(elm);
}

/** Draws every [data-buddy] / [data-scene] under root that is not mounted yet and watches [data-act]. */
export function mount(root: ParentNode = document) {
  for (const elm of root.querySelectorAll(
    '[data-buddy]:not([data-mounted]),[data-scene]:not([data-mounted])',
  )) {
    const name = elm.getAttribute('data-scene');
    elm.innerHTML = trustedHtml(
      name
        ? scene(name)
        : draw(elm.getAttribute('data-buddy') || 'rest', {
            face: elm.getAttribute('data-face') || undefined,
            dir: elm.getAttribute('data-dir') || undefined,
            label: elm.getAttribute('data-label') || undefined,
          }),
    );
    elm.setAttribute('data-mounted', '');
    watch(elm);
  }
  for (const elm of root.querySelectorAll('[data-act]:not([data-watched])')) {
    elm.setAttribute('data-watched', '');
    watch(elm);
  }
}

/** Restarts every act inside elm. */
export function replay(elm: HTMLElement) {
  const all = [elm, ...elm.querySelectorAll('.in')];
  elm.style.setProperty('--d', '0s');
  for (const e of all) e.classList.remove('in');
  void elm.offsetWidth;
  for (const e of all) e.classList.add('in');
}

function topbar() {
  const bar = document.querySelector('.topbar');
  if (!bar) return;
  const btn = bar.querySelector<HTMLElement>('.menu-btn');
  const panel = bar.querySelector('.menu-panel');
  const set = (open: boolean) => {
    bar.classList.toggle('open', open);
    btn?.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  btn?.addEventListener('click', () => set(!bar.classList.contains('open')));
  panel?.addEventListener('click', (e) => {
    if ((e.target as Element).closest('a')) set(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && bar.classList.contains('open')) {
      set(false);
      btn?.focus();
    }
  });
  const scrolled = () => bar.classList.toggle('scrolled', window.scrollY > 8);
  window.addEventListener('scroll', scrolled, { passive: true });
  scrolled();
}

/** Injects the shared defs, mounts the page, and wires replay buttons, demos and the top bar. */
export function startBuddy() {
  if (!document.querySelector('.pb-defs'))
    document.body.insertAdjacentHTML('afterbegin', trustedHtml(DEFS));
  if ('IntersectionObserver' in window) {
    io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const t = e.target;
          if (e.isIntersecting) {
            t.classList.add('in');
            t.classList.remove('off');
          } else if (t.classList.contains('in')) t.classList.add('off');
        }
      },
      { threshold: 0.15 },
    );
  }
  mount(document);
  document.addEventListener('click', (e) => {
    const rp = (e.target as Element).closest?.<HTMLElement>('[data-replay]');
    if (rp) replay(rp);
  });
  for (const d of document.querySelectorAll<HTMLElement>('[data-demo]')) demo(d);
  topbar();
}
