import type { RequestLogEntry } from '../../../shared/contracts/developer.ts';
import { LOGS_COPY } from '../../../shared/copy/developers-ops.ts';
import { LOG_API, openDetail } from './detail.ts';
import { fill, getJson, h } from './dom.ts';
import { showFirstCall, showNoMatch } from './empty.tsx';
import { notToday } from './format.ts';
import { listen } from './live.ts';
import type { OpIndex } from './ops.ts';
import { loadRail } from './rail.ts';
import { rowView } from './row.ts';
import { clearState, showFailed, showNoSandbox } from './state.tsx';
import { type Filters, toolbar } from './toolbar.ts';

interface Page {
  items: RequestLogEntry[];
  nextCursor: string | null;
  capped: 'hour' | 'total' | null;
}

const qs = (f: Filters, extra: Record<string, string> = {}) =>
  new URLSearchParams({ ...(f as Record<string, string>), ...extra }).toString();

/** The hash without its `#`; one that does not decode (`#%E0`) is no hash. */
function decodeHash(raw: string): string {
  try {
    return decodeURIComponent(raw.slice(1));
  } catch {
    // A malformed link opens the log as it is.
    return '';
  }
}

/** Up and Down move between rows, as in any list a developer scans with the keyboard. */
function arrowKeys(list: HTMLElement): void {
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const from = (e.target as Element).closest('summary');
    if (!from) return;
    const all = [...list.querySelectorAll<HTMLElement>('.logs-row > summary')];
    const next = all[all.indexOf(from) + (e.key === 'ArrowDown' ? 1 : -1)];
    if (!next) return;
    e.preventDefault();
    next.focus();
  });
}

/**
 * The request log: the filter row, one line per call, a detail that opens in place, paging by cursor, and a
 * listener that slides newer calls in at the top. Search links open a row (`#<id>`) or filter (`#code=`, `#path=`).
 */
export async function mountLogs(
  el: HTMLElement,
  ops: Promise<OpIndex>,
  liveSlot: HTMLElement | null = null,
): Promise<void> {
  const bar = toolbar();
  const hash = decodeHash(location.hash);
  if (hash.startsWith('code=')) bar.setCode(hash.slice(5));
  else if (hash.startsWith('path=')) bar.setPath(hash.slice(5));

  const first = await getJson<Page>(`${LOG_API}?${qs(bar.filters())}`).catch(() => null);
  // Signed out: the prerendered state, with its sign-in link, stays.
  if (first?.status === 401) return;
  if (first?.status === 404) return showNoSandbox(el, false);
  if (!first?.body) return showFailed(el, () => void mountLogs(el, ops, liveSlot));
  clearState(el);

  let rail: Awaited<ReturnType<typeof loadRail>>['body'] = null;
  void loadRail().then((r) => {
    rail = r.body;
  });
  /** The strip's key by its prefix; another key by the end of its id. */
  const keyLabel = (id: string | null) =>
    id ? (rail?.key?.id === id ? rail.key.prefix : `…${id.slice(-6)}`) : null;
  const open = (row: RequestLogEntry, into: HTMLElement) =>
    void openDetail(row, into, ops, keyLabel);

  const full = h('p', { class: 'sm logs-full', role: 'status', hidden: true });
  const list = h('div', { class: 'card logs-list' });
  const empty = h('div', { class: 'logs-empty', hidden: true });
  const shown = h('span', { class: 'xs muted' });
  const more = h(
    'button',
    { type: 'button', class: 'btn outline sm', hidden: true },
    LOGS_COPY.more,
  );
  const foot = h('div', { class: 'logs-foot' }, shown, more);
  const said = h('p', { class: 'sr', 'aria-live': 'polite' });
  fill(el, full, bar.el, list, empty, foot, said);
  arrowKeys(list);

  let cursor: string | null = null;
  let newest: string | null = null;
  let run = 0;
  let busy: ReturnType<typeof setTimeout> | undefined;
  const ids = new Set<string>();
  const rows = () => list.querySelectorAll<HTMLDetailsElement>('details[data-id]');

  /** Rows for calls not shown yet; the Code select learns their codes, the time column widens for a date. */
  const views = (items: RequestLogEntry[]) => {
    const now = Date.now();
    bar.seeCodes(items.flatMap((r) => (r.code ? [r.code] : [])));
    if (items.some((r) => notToday(r.at, now))) list.dataset.days = '';
    const fresh = items.filter((r) => !ids.has(r.id));
    for (const r of fresh) ids.add(r.id);
    return fresh.map((r) => rowView(r, open, now));
  };

  /** What shows when there are no rows: the first call to make, or the way out of the filters. */
  async function nothing() {
    list.hidden = true;
    foot.hidden = true;
    empty.hidden = false;
    const filtering = Object.keys(bar.filters()).some((k) => k !== 'source');
    bar.el.hidden = !bar.narrowed();
    if (filtering) return showNoMatch(empty, () => bar.clear());
    const mine = run;
    const [railRead, portal] = await Promise.all([
      loadRail(),
      bar.filters().source === 'key'
        ? getJson<Page>(`${LOG_API}?source=try&limit=1`).catch(() => null)
        : null,
    ]);
    if (mine !== run || !list.hidden) return;
    showFirstCall(empty, {
      origin: location.origin,
      hasKey: railRead.body ? railRead.body.key !== null : true,
      onPortal: portal?.body?.items.length ? () => bar.setSource('try') : undefined,
    });
  }

  function something() {
    clearState(empty);
    empty.hidden = true;
    list.hidden = false;
    foot.hidden = false;
    bar.el.hidden = false;
  }

  function show(page: Page, append: boolean) {
    cursor = page.nextCursor;
    full.hidden = page.capped === null;
    full.textContent = page.capped ? LOGS_COPY.capped[page.capped] : '';
    if (!append) {
      ids.clear();
      delete list.dataset.days;
      newest = page.items[0]?.id ?? null;
    }
    const made = views(page.items);
    if (append) list.append(...made);
    else fill(list, ...made);
    more.hidden = cursor === null;
    shown.textContent = LOGS_COPY.count(rows().length);
    if (rows().length === 0) void nothing();
    else something();
  }

  async function load(append: boolean) {
    const mine = ++run;
    const extra: Record<string, string> = append && cursor ? { cursor } : {};
    // A refetch keeps the old rows; after 150 ms they dim and the card's top edge runs the loading rail.
    clearTimeout(busy);
    busy = setTimeout(() => list.setAttribute('aria-busy', 'true'), 150);
    const res = await getJson<Page>(`${LOG_API}?${qs(bar.filters(), extra)}`).catch(() => null);
    if (mine !== run) return;
    clearTimeout(busy);
    list.removeAttribute('aria-busy');
    if (res?.body) return show(res.body, append);
    something();
    fill(list, h('p', { class: 'logs-none sm muted' }, LOGS_COPY.failed));
  }

  /** Newer calls under the same filters, slid in at the top. */
  async function tick() {
    const mine = run;
    const res = await getJson<Page>(
      `${LOG_API}?${qs(bar.filters(), newest ? { after: newest } : {})}`,
    ).catch(() => null);
    if (mine !== run || !res?.body?.items.length) return;
    const made = views(res.body.items);
    newest = res.body.items[0]?.id ?? newest;
    if (made.length === 0) return;
    for (const row of made) row.classList.add('logs-new');
    something();
    list.prepend(...made);
    shown.textContent = LOGS_COPY.count(rows().length);
    said.textContent = LOGS_COPY.live.fresh(made.length);
    live.heard();
  }

  /** `#<row id>` or `#<request id>` opens that call, fetched when it is older than the page. */
  async function openFromHash(initial = false) {
    const hash = decodeHash(location.hash);
    const filter = /^(code|path)=/.exec(hash)?.[1];
    if (filter) {
      // The first read already carried the hash's filter.
      if (!initial) (filter === 'code' ? bar.setCode : bar.setPath)(hash.slice(5));
      return;
    }
    if (!hash) return;
    const wanted = hash.toLowerCase();
    let row = [...rows()].find((r) => r.dataset.id === hash || r.dataset.requestId === wanted);
    if (!row) {
      const { body } = await getJson<RequestLogEntry>(`${LOG_API}/${encodeURIComponent(hash)}`);
      if (!body) return;
      ids.add(body.id);
      row = rowView(body, open);
      row.dataset.pinned = '';
      something();
      list.prepend(row);
    }
    row.open = true;
    row.scrollIntoView({ block: 'center' });
    row.querySelector('summary')?.focus({ preventScroll: true });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  bar.onChange(() => {
    clearTimeout(timer);
    timer = setTimeout(() => void load(false), 250);
  });
  more.addEventListener('click', () => void load(true));
  const live = listen(
    () =>
      tick().catch(() => {
        // A missed poll is a missed poll: the next one asks again from the same row.
      }),
    el,
  );
  liveSlot?.replaceChildren(live.el);
  show(first.body, false);
  void openFromHash(true);
  window.addEventListener('hashchange', () => void openFromHash());
}
