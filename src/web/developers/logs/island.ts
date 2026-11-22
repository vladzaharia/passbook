import type { z } from 'zod';
import type {
  RequestLogDetail,
  RequestLogEntry,
  RequestLogQuerySchema,
} from '../../../shared/contracts/developer.ts';
import { LOGS_COPY } from '../../../shared/copy/developers-ops.ts';
import { fill, getJson, h } from './dom.ts';
import { clock, flavour, prettyBody } from './format.ts';
import { builderLink, type OpIndex } from './ops.ts';
import { clearState, showFailed, showNoSandbox } from './state.tsx';

type Filters = Partial<z.input<typeof RequestLogQuerySchema>>;
const API = '/api/v1/developer/logs';

function field(label: string, control: HTMLElement): HTMLElement {
  return h('label', { class: 'logs-field' }, h('span', { class: 'xs muted' }, label), control);
}

function select(name: string, any: string, options: readonly { value: string; label: string }[]) {
  return h(
    'select',
    { name, class: 'logs-input' },
    h('option', { value: '' }, any),
    ...options.map((o) => h('option', { value: o.value }, o.label)),
  );
}

function bodyBlock(title: string, raw: string | null): HTMLElement {
  const text = prettyBody(raw);
  return h(
    'section',
    { class: 'logs-body' },
    h('h4', { class: 'xs muted' }, title),
    text === null
      ? h('p', { class: 'sm muted' }, LOGS_COPY.detail.noBody)
      : h(
          'pre',
          { class: 'src', tabindex: '0' },
          h('code', {}, ...text.split('\n').map((line) => h('span', { class: 'ln' }, line || ' '))),
        ),
  );
}

async function openDetail(row: RequestLogEntry, into: HTMLElement, ops: Promise<OpIndex>) {
  const [{ body }, index] = await Promise.all([getJson<RequestLogDetail>(`${API}/${row.id}`), ops]);
  const link = builderLink(index, row.method, row.route);
  const copy = h(
    'button',
    { type: 'button', class: 'btn ghost sm', 'data-copy': true, 'data-copy-text': row.requestId },
    LOGS_COPY.detail.copyId,
  );
  const facts = h(
    'div',
    { class: 'logs-facts' },
    h('code', { class: 'mono xs' }, row.requestId),
    row.keyId
      ? h('span', { class: 'xs muted' }, `${LOGS_COPY.detail.key} ${row.keyId.slice(0, 8)}`)
      : null,
    row.via ? h('span', { class: 'pill neutral' }, LOGS_COPY.detail.via) : null,
    copy,
    link ? h('a', { class: 'btn outline sm', href: link }, LOGS_COPY.detail.openInBuilder) : null,
  );
  if (!body) return fill(into, facts, h('p', { class: 'sm muted' }, LOGS_COPY.failed));
  fill(
    into,
    facts,
    body.hasBodies
      ? h(
          'div',
          { class: 'logs-bodies' },
          bodyBlock(LOGS_COPY.detail.request, body.requestBody),
          bodyBlock(LOGS_COPY.detail.response, body.responseBody),
        )
      : h('p', { class: 'sm muted' }, LOGS_COPY.detail.bodiesGone),
    body.bodiesExpireAt
      ? h('p', { class: 'xs muted' }, `${LOGS_COPY.detail.expires} ${clock(body.bodiesExpireAt)}`)
      : null,
  );
}

function rowView(row: RequestLogEntry, ops: Promise<OpIndex>): HTMLElement {
  const detail = h('div', { class: 'logs-detail' });
  const el = h(
    'details',
    { class: 'logs-row', 'data-id': row.id, 'data-request-id': row.requestId.toLowerCase() },
    h(
      'summary',
      { class: 'lrow logs-sum' },
      h(
        'time',
        { class: 'xs muted nowrap logs-time', datetime: new Date(row.at).toISOString() },
        clock(row.at),
      ),
      h(
        'span',
        { class: `method ${row.method === 'DELETE' ? 'del' : row.method.toLowerCase()}` },
        row.method === 'DELETE' ? 'DEL' : row.method,
      ),
      h(
        'span',
        { class: 'logs-where' },
        h(
          'code',
          { class: 'mono sm logs-path' },
          row.path.replace(/^\/api\/v1/, '') + (row.query ? `?${row.query}` : ''),
        ),
        row.code ? h('code', { class: 'mono xs logs-code' }, row.code) : null,
      ),
      h('span', { class: `pill ${flavour(row.status)} mono logs-status` }, String(row.status)),
      h('span', { class: 'xs muted nowrap logs-ms' }, `${row.durationMs} ms`),
    ),
    detail,
  );
  let loaded = false;
  el.addEventListener('toggle', () => {
    if (!el.open || loaded) return;
    loaded = true;
    fill(detail, h('p', { class: 'sm muted' }, LOGS_COPY.loading));
    void openDetail(row, detail, ops);
  });
  return el;
}

type Page = {
  items: RequestLogEntry[];
  nextCursor: string | null;
  capped: 'hour' | 'total' | null;
};

/** The hash without its `#`; one that does not decode (`#%E0`) is no hash. */
function decodeHash(raw: string): string {
  try {
    return decodeURIComponent(raw.slice(1));
  } catch {
    // A malformed link opens the log as it is.
    return '';
  }
}

/** The request log: filters, the list, and a detail row with redacted bodies. Text and DOM calls only. */
export async function mountLogs(el: HTMLElement, ops: Promise<OpIndex>): Promise<void> {
  const first = await getJson<Page>(API);
  // Signed out: the prerendered state, with its sign-in link, stays.
  if (first.status === 401) return;
  if (first.status === 404) return showNoSandbox(el, false);
  if (!first.body) return showFailed(el, () => void mountLogs(el, ops));
  clearState(el);

  const status = select('status', LOGS_COPY.filters.anyStatus, LOGS_COPY.statusOptions);
  const method = select(
    'method',
    LOGS_COPY.filters.anyMethod,
    ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => ({ value: m, label: m })),
  );
  const text = (name: string, placeholder: string) =>
    h('input', {
      name,
      class: 'logs-input mono',
      placeholder,
      autocomplete: 'off',
      spellcheck: 'false',
    });
  const code = text('code', LOGS_COPY.filters.codePlaceholder);
  const path = text('path', LOGS_COPY.filters.pathPlaceholder);
  const clear = h('button', { type: 'button', class: 'btn ghost sm' }, LOGS_COPY.filters.clear);
  const bar = h(
    'form',
    { class: 'logs-filters', role: 'search' },
    field(LOGS_COPY.filters.status, status),
    field(LOGS_COPY.filters.method, method),
    field(LOGS_COPY.filters.code, code),
    field(LOGS_COPY.filters.path, path),
    clear,
  );
  const list = h('div', { class: 'list card logs-list' });
  const more = h('button', { type: 'button', class: 'btn outline', hidden: true }, LOGS_COPY.more);
  const full = h('p', { class: 'sm logs-full', role: 'status', hidden: true });
  fill(
    el,
    full,
    bar,
    list,
    h('div', { class: 'logs-more' }, more),
    h('p', { class: 'xs muted mt4' }, LOGS_COPY.retention),
  );

  let cursor: string | null = null;
  let run = 0;
  const filters = (): Filters => ({
    ...(status.value ? { status: status.value } : {}),
    ...(method.value ? { method: method.value as 'GET' } : {}),
    ...(code.value.trim() ? { code: code.value.trim().toUpperCase() } : {}),
    ...(path.value.trim() ? { path: path.value.trim() } : {}),
  });

  function show(body: Page, append: boolean) {
    cursor = body.nextCursor;
    more.hidden = cursor === null;
    full.hidden = body.capped === null;
    full.textContent = body.capped ? LOGS_COPY.capped[body.capped] : '';
    const rows = body.items.map((r) => rowView(r, ops));
    if (append) return list.append(...rows);
    const empty = Object.keys(filters()).length > 0 ? LOGS_COPY.noMatch : LOGS_COPY.empty;
    fill(list, ...(rows.length > 0 ? rows : [h('p', { class: 'lrow muted' }, empty)]));
  }

  async function load(append: boolean) {
    const mine = ++run;
    const query = new URLSearchParams(filters() as Record<string, string>);
    if (append && cursor) query.set('cursor', cursor);
    if (!append) fill(list, h('p', { class: 'lrow muted' }, LOGS_COPY.loading));
    const { body } = await getJson<Page>(`${API}?${query}`);
    if (mine !== run) return;
    if (body) show(body, append);
    else fill(list, h('p', { class: 'lrow muted' }, LOGS_COPY.failed));
  }

  /** From search: `#<row id>` opens that request (fetched when it is older than the page), `#code=X` filters by code. */
  async function openFromHash() {
    const hash = decodeHash(location.hash);
    if (hash.startsWith('code=')) {
      code.value = hash.slice('code='.length).toUpperCase();
      return refresh();
    }
    if (hash.startsWith('path=')) {
      path.value = hash.slice('path='.length);
      return refresh();
    }
    if (!hash) return;
    const wanted = hash.toLowerCase();
    let row = [...list.querySelectorAll<HTMLDetailsElement>('details[data-id]')].find(
      (r) => r.dataset.id === hash || r.dataset.requestId === wanted,
    );
    if (!row) {
      const { body } = await getJson<RequestLogEntry>(`${API}/${encodeURIComponent(hash)}`);
      if (!body) return;
      row = rowView(body, ops) as HTMLDetailsElement;
      list.prepend(row);
    }
    row.open = true;
    row.scrollIntoView({ block: 'center' });
  }

  show(first.body, false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void load(false), 250);
  };
  void openFromHash();
  window.addEventListener('hashchange', () => void openFromHash());
  for (const control of [status, method]) control.addEventListener('change', refresh);
  for (const control of [code, path]) control.addEventListener('input', refresh);
  bar.addEventListener('submit', (e) => e.preventDefault());
  clear.addEventListener('click', () => {
    bar.reset();
    refresh();
  });
  more.addEventListener('click', () => void load(true));
}
