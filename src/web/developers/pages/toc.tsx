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
          <li key={c.href ?? 'here'}>
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

export interface TocItem {
  id: string;
  label: string;
}

/** "On this page": the sections the renderer lists for a page, each an id on that page. */
export function Toc({ items }: { items: readonly TocItem[] }) {
  return (
    <nav className="toc" aria-label={DEV_COPY.reference.onThisPage} data-toc>
      <p className="toc-h">{DEV_COPY.reference.onThisPage}</p>
      <ul>
        {items.map((i) => (
          <li key={i.id}>
            <a href={`#${i.id}`}>{i.label}</a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
