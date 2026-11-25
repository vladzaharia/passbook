import { replay, startBuddy } from '../buddy/index.ts';
import '../styles/page-door.css';
import { trustedHtml } from '../trusted-html.ts';

startBuddy();

/* Live board: a new arrival or exit every few seconds while in view; still under reduced motion. */
const root = document.querySelector<HTMLElement>('.door-live');
const n = document.getElementById('door-n');
const bar = document.getElementById('door-bar');
const rows = document.getElementById('door-rows');
const pin = document.getElementById('door-in');
const pout = document.getElementById('door-out');
const buddy = root?.querySelector<HTMLElement>('[data-buddy]');
const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

if (root && n && bar && rows && pin && pout && !still) {
  const inA = [3, 5, 4, 6, 5, 7, 4, 5, 6, 3, 5, 6, 4, 5, 6];
  const outA = [1, 2, 1, 0, 2, 1, 3, 1, 2, 1, 2, 0, 1, 2, 1];
  const events: [string, number][] = [
    ['Leo Brandt', 1],
    ['Dana Whitfield', 1],
    ['Jonas Lindqvist', 0],
    ['Ines Varga', 1],
    ['Sana Okoye', 0],
    ['Omar Beck', 0],
  ];
  const cols = ['#2dd4bf', '#ffc24d', '#ff6fa6', '#60a5fa', '#9a5cff'];
  const list: [string, number, string][] = [
    ['Priya Nair', 1, '18:40'],
    ['Tomas Reyes', 1, '18:36'],
    ['Sam Okafor', 0, '18:30'],
    ['Mina Haddad', 1, '18:24'],
  ];
  let count = 42;
  let e = 0;
  let minute = 18 * 60 + 41;
  let c = 0;
  const pad = (v: number) => (v < 10 ? `0${v}` : `${v}`);
  const pts = (a: number[]) =>
    a.map((v, i) => `${((i * 300) / 14).toFixed(1)},${(52 - v * 6).toFixed(1)}`).join(' ');
  const initials = (s: string) =>
    s
      .split(' ')
      .map((w) => w.charAt(0))
      .join('');
  const draw = (fresh: boolean) => {
    rows.innerHTML = trustedHtml(
      list
        .map(
          (r, i) =>
            `<li class="door-row${r[1] ? '' : ' out'}${fresh && i === 0 ? ' door-new' : ''}"><span class="door-av" style="background:${cols[(c + i) % 5]}">${initials(r[0])}</span><b>${r[0]}<small>${r[1] ? 'In' : 'Out · auto'}</small></b><time>${r[2]}</time></li>`,
        )
        .join(''),
    );
    pin.setAttribute('points', pts(inA));
    pout.setAttribute('points', pts(outA));
  };
  const tick = () => {
    if (root.classList.contains('off') || !root.classList.contains('in') || document.hidden) return;
    const ev = events[e % events.length] as [string, number];
    e++;
    c++;
    minute++;
    count += ev[1] ? 1 : -1;
    n.textContent = String(count);
    bar.style.width = `${(count / 60) * 100}%`;
    n.classList.remove('pop');
    void n.offsetWidth;
    n.classList.add('pop');
    list.unshift([ev[0], ev[1], `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`]);
    list.length = 4;
    inA.shift();
    inA.push(ev[1] ? 7 : 4);
    outA.shift();
    outA.push(ev[1] ? 1 : 4);
    draw(true);
    if (buddy && ev[1]) replay(buddy);
  };
  draw(false);
  bar.style.width = '70%';
  setInterval(tick, 3600);
}
