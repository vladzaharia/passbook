import { ACCESS_COPY } from '@/shared/copy/access.ts';
import { strictEmail } from '@/shared/email.ts';
import { draw, star, startBuddy, svg } from '../buddy/index.ts';
import '../styles/page-access.css';
import { trustedHtml } from '../trusted-html.ts';

const FIELDS = ['name', 'email', 'org', 'purpose', 'message', 'website'] as const;

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = byId<HTMLFormElement>('acc-form');
const ticket = byId('acc-ticket');
const done = byId('acc-done');
const buddy = byId('acc-buddy');
const sparks = byId('acc-sparks');
const sendError = byId('acc-send-e');
const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

startBuddy();
// The page works as a plain form post without script; with script the checks run here.
form.noValidate = true;

const rules: Record<string, (v: string) => string> = {
  name: (v) => (v.trim() ? '' : 'Enter your name.'),
  email: (v) => (strictEmail(v) ? '' : 'Enter a work email.'),
  org: (v) => (v.trim() ? '' : 'Enter your organization.'),
  for: (v) => (v ? '' : 'Choose what the pass is for.'),
};
const ids: Record<string, string> = {
  name: 'a-name',
  email: 'a-email',
  org: 'a-org',
  for: 'a-for',
};
const field = (k: string) => byId<HTMLInputElement | HTMLSelectElement>(ids[k] as string);

function check(k: string, show: boolean): boolean {
  const el = field(k);
  const msg = (rules[k] as (v: string) => string)(el.value);
  const e = byId(`${ids[k]}-e`);
  if (show) {
    e.textContent = msg;
    if (msg) {
      el.setAttribute('aria-invalid', 'true');
      el.setAttribute('aria-describedby', e.id);
    } else {
      el.removeAttribute('aria-invalid');
      el.removeAttribute('aria-describedby');
    }
  }
  return !msg;
}
const valid = () => Object.keys(rules).every((k) => check(k, false));

let mood = 'curious';
function setBuddy(pose: string) {
  if (mood === pose) return;
  mood = pose;
  buddy.innerHTML = trustedHtml(draw(pose));
}
const sync = () => {
  if (!ticket.classList.contains('sent')) setBuddy(valid() ? 'happy' : 'curious');
};

for (const k of Object.keys(ids)) {
  const el = field(k);
  el.addEventListener('blur', () => {
    if (el.value || el.getAttribute('aria-invalid')) check(k, true);
  });
  el.addEventListener('input', () => {
    if (el.getAttribute('aria-invalid')) check(k, true);
    sync();
  });
  el.addEventListener('change', () => {
    check(k, true);
    sync();
  });
}

function sparksOn() {
  const pts: [number, number, string][] = [
    [-30, 10, '#2dd4bf'],
    [-14, -28, '#9a5cff'],
    [44, -40, '#ffc24d'],
    [112, -30, '#ff6fa6'],
    [134, 6, '#2dd4bf'],
    [124, 44, '#ffc24d'],
  ];
  const s = pts
    .map(([x, y, fill], i) => `<g class="s-spark" style="--i:${i}">${star(x, y, 1, fill)}</g>`)
    .join('');
  sparks.innerHTML = trustedHtml(svg('-40 -60 200 140', s));
  sparks.classList.add('in');
}

function showSent(animate: boolean) {
  ticket.classList.remove('sending');
  ticket.classList.add('sent');
  form.hidden = true;
  done.hidden = false;
  setBuddy('tuck');
  sparksOn();
  if (animate) done.focus({ preventScroll: true });
}

function showNotSent() {
  ticket.classList.remove('sending');
  setBuddy('sorry');
  sendError.textContent = ACCESS_COPY.unavailable;
  sendError.hidden = false;
  submitting = false;
}

/** True only for 204: any other answer, or no answer, means the request was not sent. */
function post(): Promise<boolean> {
  const body: Record<string, string> = {};
  const data = new FormData(form);
  for (const k of FIELDS) {
    const v = data.get(k);
    body[k] = typeof v === 'string' ? v.trim() : '';
  }
  return fetch('/access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  }).then(
    (res) => res.status === 204,
    () => false,
  );
}

let submitting = false;
form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (submitting) return;
  let first: HTMLElement | null = null;
  for (const k of Object.keys(rules)) if (!check(k, true) && !first) first = field(k);
  if (first) {
    first.focus();
    return;
  }
  submitting = true;
  sendError.hidden = true;
  sendError.textContent = '';
  const request = post();
  if (still) {
    void request.then((ok) => (ok ? showSent(true) : showNotSent()));
    return;
  }
  const tr = ticket.getBoundingClientRect();
  const br = buddy.getBoundingClientRect();
  const fx = br.left + br.width / 2 - (tr.left + 24 + 42);
  const fy = br.top + br.height * 0.4 - (tr.top + 14 + 26);
  ticket.style.setProperty('--fx', `${fx}px`);
  ticket.style.setProperty('--fy', `${fy}px`);
  ticket.classList.add('sending');
  setBuddy('tuck');
  const flown = new Promise<void>((resolve) => setTimeout(resolve, 800));
  void Promise.all([request, flown]).then(([ok]) => (ok ? showSent(true) : showNotSent()));
});

const init = () => {
  if (location.hash === '#sent') showSent(false);
  // /access/sent arrives with the sent state already in the markup.
  else if (ticket.classList.contains('sent')) sparksOn();
};
window.addEventListener('hashchange', init);
if (document.readyState === 'complete') init();
else window.addEventListener('load', init);
