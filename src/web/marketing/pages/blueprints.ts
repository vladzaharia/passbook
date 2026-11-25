import { startBuddy } from '../buddy/index.ts';
import '../styles/page-blueprints.css';

startBuddy();

if (location.hash === '#flipped') {
  for (const b of document.querySelectorAll('.bp-flip')) b.classList.add('is-flipped');
}
const chips = [...document.querySelectorAll<HTMLElement>('.bp-filter')];
const items = [...document.querySelectorAll<HTMLElement>('.bp-item')];
const live = document.getElementById('bp-live');
for (const c of chips) {
  c.addEventListener('click', () => {
    const g = c.getAttribute('data-g');
    let n = 0;
    for (const x of chips) x.setAttribute('aria-pressed', x === c ? 'true' : 'false');
    for (const it of items) {
      const on = g === 'all' || it.getAttribute('data-g') === g;
      it.hidden = !on;
      it.classList.remove('show');
      if (on) {
        it.style.setProperty('--n', String(n++));
        void it.offsetWidth;
        it.classList.add('show');
      }
    }
    if (live) live.textContent = `Showing ${n} of ${items.length}`;
  });
}
const grid = document.getElementById('bp-grid');
let ptr = 'mouse';
grid?.addEventListener('pointerdown', (e) => {
  ptr = e.pointerType;
});
grid?.addEventListener('click', (e) => {
  const b = (e.target as Element).closest('.bp-flip');
  if (!b) return;
  if (ptr === 'mouse' && e.detail > 0 && window.matchMedia('(hover:hover)').matches) return;
  b.setAttribute('aria-pressed', b.classList.toggle('is-flipped') ? 'true' : 'false');
});
