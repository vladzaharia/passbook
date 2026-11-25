import type { z } from 'zod';
import type { RequestLogQuerySchema } from '../../../shared/contracts/developer.ts';
import { LOGS_COPY } from '../../../shared/copy/developers-ops.ts';
import { h } from './dom.ts';
import { icon } from './icons.ts';
import { kitSelect } from './select.ts';

export type Filters = Partial<z.input<typeof RequestLogQuerySchema>>;
const F = LOGS_COPY.filters;
const ANY = { value: '', label: F.any };
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => ({ value: m, label: m }));
/** Yours is the default: the portal's own reads would bury your calls (the workbench does the same). */
const DEFAULT_SOURCE = 'key';

interface Toolbar {
  el: HTMLElement;
  /** The query the list reads, Source always included. */
  filters(): Filters;
  /** Anything narrower than the default view. */
  narrowed(): boolean;
  clear(): void;
  setCode(code: string): void;
  setPath(path: string): void;
  setSource(source: 'key' | 'try' | 'all'): void;
  /** Codes seen in the rows so far: the Code select lists them. */
  seeCodes(codes: Iterable<string>): void;
  onChange(run: () => void): void;
}

/**
 * The FilterBar row: path search first, then Status, Method, Code and Source as kit selects, Clear only when
 * something is set, and the one retention line. Below 640 the selects sit in two columns (logs.css).
 */
export function toolbar(): Toolbar {
  const path = h('input', {
    type: 'search',
    name: 'path',
    class: 'mono',
    placeholder: F.search,
    'aria-label': F.search,
    autocomplete: 'off',
    spellcheck: 'false',
    maxlength: '200',
  });
  const status = kitSelect('status', F.status, ANY, LOGS_COPY.statusOptions);
  const method = kitSelect('method', F.method, ANY, METHODS);
  const code = kitSelect('code', F.code, ANY, []);
  const [yours, ...others] = LOGS_COPY.sources;
  const source = kitSelect('source', F.source, yours, others, DEFAULT_SOURCE);
  const selects = [status, method, code, source];
  const clear = h(
    'button',
    { type: 'button', class: 'btn ghost logs-clear', hidden: true },
    icon('x'),
    F.clear,
  );
  const el = h(
    'search',
    { class: 'logs-bar' },
    h('div', { class: 'logs-q' }, icon('search'), path),
    ...selects.map((s) => s.el),
    clear,
    h('p', { class: 'xs muted logs-note' }, LOGS_COPY.retention),
  );
  const codes = new Set<string>();
  const listeners: (() => void)[] = [];
  const narrowed = () => Boolean(path.value.trim()) || selects.some((s) => s.isSet());
  const changed = () => {
    clear.hidden = !narrowed();
    for (const run of listeners) run();
  };
  path.addEventListener('input', changed);
  for (const s of selects) s.select.addEventListener('change', changed);
  clear.addEventListener('click', () => {
    api.clear();
    path.focus();
  });

  const api: Toolbar = {
    el,
    filters: () => ({
      ...(status.select.value ? { status: status.select.value } : {}),
      ...(method.select.value ? { method: method.select.value as 'GET' } : {}),
      ...(code.select.value ? { code: code.select.value } : {}),
      ...(path.value.trim() ? { path: path.value.trim() } : {}),
      source: source.select.value as 'key',
    }),
    narrowed,
    clear() {
      path.value = '';
      for (const s of selects) s.reset();
      changed();
    },
    setCode(v) {
      code.set(v.toUpperCase());
      changed();
    },
    setPath(v) {
      path.value = v;
      changed();
    },
    setSource(v) {
      source.set(v);
      changed();
    },
    seeCodes(seen) {
      const before = codes.size;
      for (const c of seen) codes.add(c);
      if (codes.size === before) return;
      code.options([...codes].sort().map((c) => ({ value: c, label: c })));
    },
    onChange: (run) => void listeners.push(run),
  };
  return api;
}
