import { createContext, type ReactNode, useContext, useState } from 'react';
import { PATHS } from '../../../shared/developers.ts';
import type { Json } from '../console/types.ts';
import { copyToClipboard as copyText } from '../shell/copy.ts';
import './json-tree.css';

const MAX_ITEMS = 100;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pages a response may link to: the TEST preview, pass pages and these docs. Not sign-in or API paths. */
const LINKABLE = [/^\/preview\//, /^\/p\//, /^\/developers(\/|$)/];

/** A link only to this site: a response cannot make us link anywhere else, nor to a `javascript:` URL. */
export function safeLink(value: string): string | null {
  try {
    const url = new URL(value);
    const web = url.protocol === 'https:' || url.protocol === 'http:';
    return web && url.origin === location.origin && LINKABLE.some((r) => r.test(url.pathname))
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** How an id in the body draws: the bench gives an IdChip; the console, a copy button. */
const IdView = createContext<((id: string) => ReactNode) | null>(null);

function Str({ k, v, codes }: { k: string; v: string; codes: ReadonlySet<string> }) {
  const [copied, setCopied] = useState(false);
  const idView = useContext(IdView);
  const text = JSON.stringify(v);
  const href = safeLink(v);
  if (href)
    return (
      <a className="s jt-link" href={href} target="_blank" rel="noopener noreferrer">
        {text}
      </a>
    );
  if (k === 'code' && codes.has(v))
    return (
      <a className="s jt-link" href={`${PATHS.errors}/${v}`}>
        {text}
      </a>
    );
  if (ID.test(v) && idView) return <span className="s jt-chip">{idView(v)}</span>;
  if (ID.test(v))
    return (
      <button
        type="button"
        className="s jt-link jt-id"
        title="Copy id"
        aria-label={`Copy id ${v}`}
        onClick={() => void copyText(v).then(setCopied)}
      >
        {text}
        {copied ? <span className="jt-copied"> copied</span> : null}
      </button>
    );
  return <span className="s">{text}</span>;
}

function Leaf({ k, v, codes }: { k: string; v: Json; codes: ReadonlySet<string> }) {
  if (typeof v === 'string') return <Str k={k} v={v} codes={codes} />;
  if (typeof v === 'number') return <span className="n">{String(v)}</span>;
  return <span className="l">{String(v)}</span>;
}

interface NodeProps {
  name?: string;
  value: Json;
  depth: number;
  last: boolean;
  codes: ReadonlySet<string>;
}

function Node({ name, value, depth, last, codes }: NodeProps) {
  const container = value !== null && typeof value === 'object';
  const [open, setOpen] = useState(depth < 2);
  const comma = last ? '' : ',';
  const key = name === undefined ? null : <span className="k">{JSON.stringify(name)}: </span>;
  const pad = { paddingInlineStart: `${depth * 16}px` };
  if (!container)
    return (
      <div className="jt-line" style={pad}>
        {key}
        <Leaf k={name ?? ''} v={value} codes={codes} />
        {comma}
      </div>
    );
  const isArr = Array.isArray(value);
  const entries: [string, Json][] = isArr
    ? (value as Json[]).slice(0, MAX_ITEMS).map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, Json>);
  const total = isArr ? (value as Json[]).length : entries.length;
  const [o, c] = isArr ? ['[', ']'] : ['{', '}'];
  const noun = isArr ? 'items' : 'fields';
  return (
    <>
      <div className="jt-line" style={pad}>
        {total > 0 ? (
          <button
            type="button"
            className="jt-toggle"
            aria-expanded={open}
            aria-label={`${open ? 'Collapse' : 'Expand'} ${name ?? 'response'}`}
            onClick={() => setOpen(!open)}
          >
            <span aria-hidden="true">{open ? '▾' : '▸'}</span>
          </button>
        ) : (
          <span className="jt-toggle" />
        )}
        {key}
        <span className="p">{o}</span>
        {open && total > 0 ? null : (
          <span className="p">
            {total > 0 ? ` ${total} ${noun} ` : ''}
            {c}
            {comma}
          </span>
        )}
      </div>
      {open
        ? entries.map(([k, v], i) => (
            <Node
              key={k}
              {...(isArr ? {} : { name: k })}
              value={v}
              depth={depth + 1}
              last={i === entries.length - 1 && total <= MAX_ITEMS}
              codes={codes}
            />
          ))
        : null}
      {open && total > MAX_ITEMS ? (
        <div className="jt-line p" style={{ paddingInlineStart: `${(depth + 1) * 16}px` }}>
          … {total - MAX_ITEMS} more
        </div>
      ) : null}
      {open && total > 0 ? (
        <div className="jt-line p" style={pad}>
          {c}
          {comma}
        </div>
      ) : null}
    </>
  );
}

/**
 * The response as a collapsible tree. Every value is a text node; links are built here, from a short
 * allow-list. `renderId` draws each UUID (the bench's IdChip); `label` names the region.
 */
export function JsonTree({
  value,
  codes,
  label = 'Response body',
  renderId,
}: {
  value: Json;
  codes: ReadonlySet<string>;
  label?: string;
  renderId?: (id: string) => ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region
    <section className="region jt" tabIndex={0} aria-label={label}>
      <IdView.Provider value={renderId ?? null}>
        <Node value={value} depth={0} last codes={codes} />
      </IdView.Provider>
    </section>
  );
}
