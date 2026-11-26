import { lazy, Suspense, useMemo } from 'react';
import type { Json } from '../console/types.ts';
import type { Lang } from '../model/highlight.ts';
import { CodeView } from '../ui/code-view.tsx';
import { type CopyAsItem, CopyAsMenu } from '../ui/copy-as-menu.tsx';
import { CopyBtn, WrapToggle } from '../ui/copy-button.tsx';
import { JsonTree } from '../ui/json-tree.tsx';
import './code-block.css';

const NO_CODES: ReadonlySet<string> = new Set();

/** The body as JSON when it is JSON; undefined for anything else (a marker line, text, nothing). */
export function parseBody(body: string | null | undefined): Json | undefined {
  if (!body) return undefined;
  const t = body.trimStart();
  if (t[0] !== '{' && t[0] !== '[') return undefined;
  try {
    return JSON.parse(body) as Json;
  } catch {
    // Not JSON after all (cut off, or a marker): shown as text.
    return undefined;
  }
}

// The chip and its menu load when an id first shows in a body: a page that only reads code keeps them out of its island.
const IdChip = lazy(() => import('./id-chip.tsx').then((m) => ({ default: m.IdChip })));

/**
 * A body in the bench: UX4's one block header (its label, Wrap on phones, one Copy, Copy as) over
 * the body. JSON draws as the tree, each id an IdChip; anything else as highlighted lines. `empty`
 * says what an absent body means ("No body"), in one quiet line instead of an empty box.
 */
export function BenchCode({
  label,
  body,
  lang = 'json',
  items,
  codes = NO_CODES,
  empty,
}: {
  label: string;
  body: string | null | undefined;
  lang?: Lang;
  /** Copy as: curl, the SDKs, Markdown. */
  items?: CopyAsItem[];
  /** Error codes that link to their page. */
  codes?: ReadonlySet<string>;
  empty: string;
}) {
  const json = useMemo(() => parseBody(body), [body]);
  if (!body) return <p className="bench-code-none">{empty}</p>;
  const text = json === undefined ? body : JSON.stringify(json, null, 2);
  return (
    <div className="code bench-code">
      <div className="code-h">
        <span className="code-label">{label}</span>
        <div className="code-tools">
          <WrapToggle />
          <CopyBtn text={text} label={`Copy ${label.toLowerCase()}`} />
          {items && items.length > 0 ? <CopyAsMenu items={items} /> : null}
        </div>
      </div>
      {json === undefined ? (
        <CodeView code={body} lang={lang} label={label} />
      ) : (
        <JsonTree
          value={json}
          codes={codes}
          label={label}
          renderId={(id) => (
            <Suspense fallback={<span className="mono">{id}</span>}>
              <IdChip id={id} />
            </Suspense>
          )}
        />
      )}
    </div>
  );
}
