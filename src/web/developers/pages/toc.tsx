import { ArrowLeft, ArrowRight, ChevronRight } from 'lucide-react';
import { DEV_COPY } from '../../../shared/copy/developers.ts';
import { PATHS } from '../../../shared/developers.ts';

/** The frame's pieces around a page's content: crumbs, the Workbench row, Prev/Next, "On this page". */

export interface Crumb {
  label: string;
  /** Omitted on the page itself. */
  href?: string;
}

export function Crumbs({ items }: { items: readonly Crumb[] }) {
  return (
    <nav className="crumbs" aria-label={DEV_COPY.frame.crumbs}>
      <ol>
        {items.map((c, i) => (
          <li key={c.label}>
            {c.href && i < items.length - 1 ? (
              <a href={c.href}>{c.label}</a>
            ) : (
              <span aria-current="page">{c.label}</span>
            )}
            {i < items.length - 1 ? <ChevronRight aria-hidden="true" /> : null}
          </li>
        ))}
      </ol>
    </nav>
  );
}

interface PagerLink {
  title: string;
  href: string;
}

export interface PagerLinks {
  prev?: PagerLink;
  next?: PagerLink;
}

export function Pager({ prev, next }: PagerLinks) {
  if (!prev && !next) return null;
  const c = DEV_COPY.frame;
  return (
    <nav className="pager" aria-label={c.pager}>
      {prev ? (
        <a rel="prev" href={prev.href}>
          <span className="pager-k">
            <ArrowLeft aria-hidden="true" />
            {c.previous}
          </span>
          <span className="pager-t">{prev.title}</span>
        </a>
      ) : (
        <span />
      )}
      {next ? (
        <a rel="next" className="pager-next" href={next.href}>
          <span className="pager-k">
            {c.next}
            <ArrowRight aria-hidden="true" />
          </span>
          <span className="pager-t">{next.title}</span>
        </a>
      ) : null}
    </nav>
  );
}

export const TOOL_PATH = {
  console: PATHS.console,
  webhooks: PATHS.webhooks,
  logs: PATHS.logs,
  keys: PATHS.keys,
} as const;

/** The Workbench's pages as a row on each of them: tool pages have no left tree at 1181 px and up. */
export function ToolsRow({ path }: { path: string }) {
  return (
    <nav className="tools" aria-label={DEV_COPY.frame.workbench}>
      {DEV_COPY.workbench.map((w) => (
        <a
          key={w.key}
          href={TOOL_PATH[w.key]}
          aria-current={TOOL_PATH[w.key] === path ? 'page' : undefined}
        >
          {w.label}
        </a>
      ))}
    </nav>
  );
}

export type TocKind = 'guide' | 'op' | 'errors' | 'changelog';

interface TocItem {
  id: string;
  label: string;
}

const SLOT = /<nav class="toc"[^>]*data-toc(?:="[^"]*")?><\/nav>/;
const PARAMS = new Set(['Path', 'Query', 'Headers', 'Body']);
const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#x27;': "'",
};
const plain = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|#x27);/g, (m) => ENTITIES[m] ?? m)
    .trim();
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'section';

/** Sections of the page that deserve an entry, by kind; headings get an id when they lack one. */
function collect(main: string, kind: TocKind): { main: string; items: TocItem[] } {
  const original = new Set([...main.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1] as string));
  const made = new Set<string>();
  const items: TocItem[] = [];
  const labels = new Set<string>();
  const push = (id: string, label: string) => {
    if (labels.has(label)) return;
    labels.add(label);
    items.push({ id, label });
  };
  if (kind === 'errors')
    for (const m of main.matchAll(/<details[^>]*\sid="(errors-[A-Z0-9])"/g))
      push(m[1] as string, (m[1] as string).slice('errors-'.length));
  // The changelog's days: its sections carry the date as their id.
  if (kind === 'changelog')
    for (const m of main.matchAll(/<section class="cl-day[^"]*" id="(\d{4}-\d\d-\d\d)"/g))
      push(m[1] as string, m[1] as string);
  if (kind === 'errors' || kind === 'changelog') return { main, items };
  const out = main.replace(
    /<h([23])((?:\s[^>]*)?)>([\s\S]*?)<\/h\1>/g,
    (whole, level: string, attrs: string, inner: string) => {
      const text = plain(inner);
      let id = /\sid="([^"]+)"/.exec(attrs)?.[1];
      let tag = whole;
      if (!id) {
        id = slug(text);
        // An enclosing section already owns the plain name (the operation's `errors`): link to it.
        if (!original.has(id)) {
          const base = id;
          for (let n = 2; made.has(id) || original.has(id); n++) id = `${base}-${n}`;
          made.add(id);
          tag = `<h${level}${attrs} id="${id}">${inner}</h${level}>`;
        }
      }
      if (kind === 'guide' && level === '2') push(id, text);
      if (kind === 'op') {
        if (level === '2' && PARAMS.has(text)) push(id, 'Parameters');
        else if (text === 'Returns' || text === 'Errors' || text === 'Examples') push(id, text);
      }
      return tag;
    },
  );
  return { main: out, items };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/** The filled "On this page" nav, as markup (the page is already a string by then). */
function tocHtml(items: readonly TocItem[]): string {
  const title = DEV_COPY.reference.onThisPage;
  const links = items.map((i) => `<li><a href="#${esc(i.id)}">${esc(i.label)}</a></li>`).join('');
  return `<nav class="toc" aria-label="${title}" data-toc><p class="toc-h">${title}</p><ul>${links}</ul></nav>`;
}

/**
 * Fills the page's empty "On this page" slot from its own headings, in the page's order. Fewer than
 * two entries and there is nothing to jump between: the slot and its column go.
 */
export function withToc(html: string, kind: TocKind): string {
  const start = html.indexOf('<main id="main"');
  const end = html.indexOf('</main>', start);
  if (start < 0 || end < 0) return html;
  const { main, items } = collect(html.slice(start, end), kind);
  const body = html.slice(0, start) + main + html.slice(end);
  if (items.length < 2) return body.replace(SLOT, '').replace('class="docs has-toc', 'class="docs');
  return body.replace(SLOT, tocHtml(items));
}
