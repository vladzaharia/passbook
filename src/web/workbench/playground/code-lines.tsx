import type { ReactNode } from 'react';
import { highlight, type Lang } from '../../developers/model/highlight.ts';

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};
const decode = (text: string) => text.replace(/&(?:amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m);

/**
 * The highlighter's `<span class="..">text</span>` markup as React nodes. The portal's CSP turns
 * HTML sinks off (Trusted Types), and the markup is only spans and escaped text, so it is read
 * here instead of being set as HTML.
 */
function nodesOf(html: string): ReactNode[] {
  const root: ReactNode[] = [];
  const stack: { cls: string; kids: ReactNode[] }[] = [];
  const push = (node: ReactNode) =>
    (stack.length > 0 ? stack[stack.length - 1]?.kids : root)?.push(node);
  let key = 0;
  for (const part of html.split(/(<span class="[^"]*">|<\/span>)/)) {
    const open = /^<span class="([^"]*)">$/.exec(part);
    if (open) stack.push({ cls: open[1] ?? '', kids: [] });
    else if (part === '</span>') {
      const done = stack.pop();
      if (done)
        push(
          <span key={key++} className={done.cls}>
            {done.kids}
          </span>,
        );
    } else if (part) push(decode(part));
  }
  return root;
}

/** Highlighted lines; a line in `changed` (1-based) is the one the last edit touched. */
export function CodeLines({
  code,
  lang,
  changed,
  marked,
}: {
  code: string;
  lang: Lang;
  changed: ReadonlySet<number>;
  /** Lines to keep lit (the quickstart's "this is the line that matters"). */
  marked?: ReadonlySet<number>;
}) {
  // One block per line: `ln` spans arrive top level, each holding its tokens.
  const lines = highlight(code, lang).split(/(?=<span class="ln)/);
  return (
    <>
      {lines.map((html, i) => {
        const inner = html.replace(/^<span class="ln[^"]*">/, '').replace(/<\/span>$/, '');
        return (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity; the text is the content
            key={i}
            className={changed.has(i + 1) ? 'ln add' : marked?.has(i + 1) ? 'ln hl' : 'ln'}
          >
            {nodesOf(inner)}
          </span>
        );
      })}
    </>
  );
}
