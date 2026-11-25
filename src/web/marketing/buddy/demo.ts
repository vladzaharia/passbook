/** The Home page demo: the name field, status switch and credits stepper drive the pass and the verdict. */
export function demo(d: HTMLElement) {
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const q = (x: string) => d.querySelector<HTMLElement>(x);
  const o = (k: string) => q(`[data-o="${k}"]`);
  const show = (k: string, v: string | number) => {
    const e = o(k);
    if (e) e.textContent = String(v);
  };
  const inp = d.querySelector<HTMLInputElement>('[data-i="name"]');
  const sw = q('[data-i="status"]');
  const out = q('[data-i="credits"]');
  const sv = q('[data-sv]');
  const stt = q('[data-st]');
  const card = q('.pass');
  const ver = q('.verdict');
  const rt = q('[data-r]');
  const rn = q('[data-rn]');
  const rd = q('[data-rd]');
  if (!inp || !sw || !card || !ver || !out || !sv || !stt || !rt || !rn || !rd) return;
  let name = inp.value;
  let on = true;
  let n = Number(out.textContent) || 0;
  let t: ReturnType<typeof setTimeout>[] = [];
  let tn: ReturnType<typeof setTimeout> | undefined;
  const later = (fn: () => void, ms: number) => t.push(setTimeout(fn, still ? 0 : ms));
  const again = (e: Element, cl: string) => {
    e.classList.remove(cl);
    void (e as HTMLElement).offsetWidth;
    e.classList.add(cl);
  };
  const verdict = () => {
    const ok = on && n > 0;
    ver.classList.toggle('bad', !ok);
    rt.textContent = ok ? 'Checked in' : 'Not checked in';
    rn.textContent = name;
    rd.textContent = !on
      ? 'Membership paused'
      : n > 0
        ? `${n} credit${n === 1 ? '' : 's'} left`
        : 'No credits left';
    again(ver, 'pop');
  };
  const send = (k: string) => {
    for (const id of t) clearTimeout(id);
    t = [];
    const fl = o(k);
    if (fl?.parentElement) again(fl.parentElement, 'hit');
    again(card, 'go');
    stt.textContent = 'Sending';
    later(() => {
      stt.textContent = 'On their phone';
    }, 800);
    later(verdict, 1300);
  };
  inp.addEventListener('input', () => {
    name = inp.value.trim() || 'Member';
    show('name', name);
    clearTimeout(tn);
    tn = setTimeout(() => send('name'), 300);
  });
  sw.addEventListener('click', () => {
    on = sw.getAttribute('aria-checked') !== 'true';
    const w = on ? 'Active' : 'Paused';
    sw.setAttribute('aria-checked', on ? 'true' : 'false');
    sv.textContent = w;
    show('status', w);
    card.classList.toggle('off', !on);
    send('status');
  });
  for (const b of d.querySelectorAll('[data-d]')) {
    b.addEventListener('click', () => {
      n = Math.max(0, Math.min(30, n + Number(b.getAttribute('data-d'))));
      out.textContent = String(n);
      show('credits', n);
      send('credits');
    });
  }
}
