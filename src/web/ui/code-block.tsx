import type { ReactNode } from 'react';
import { cn } from '../lib/cn.ts';
import { CopyButton } from './copy-button.tsx';

export interface CodeBlockProps {
  code: string;
  label?: string;
  className?: string;
  maxHeight?: string;
}

function Frame({
  code,
  label = 'Code',
  className,
  maxHeight = 'max-h-96',
  children,
}: CodeBlockProps & { children: ReactNode }) {
  return (
    <div className={cn('relative rounded-md border border-border bg-surface-sunken', className)}>
      <div className="absolute top-1 right-1">
        <CopyButton value={code} label={`Copy ${label.toLowerCase()}`} />
      </div>
      {/* Focusable so keyboard users can scroll it. */}
      <section
        // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region
        tabIndex={0}
        aria-label={label}
        className={cn('overflow-auto', maxHeight)}
      >
        <pre className="p-3 pr-10 font-mono text-xs text-fg">
          <code>{children}</code>
        </pre>
      </section>
    </div>
  );
}

export function CodeBlock(props: CodeBlockProps) {
  return <Frame {...props}>{props.code}</Frame>;
}

const TOKEN =
  /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

/** JSON text split into tinted tokens: keys, strings, numbers and booleans (null with them). */
export function tintJson(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const [whole, str, colon, lit, num] = m;
    const tone = str
      ? colon
        ? 'text-info'
        : 'text-success'
      : lit
        ? 'text-accent-fg'
        : num
          ? 'text-warning'
          : '';
    out.push(
      <span
        key={at}
        className={tone}
        data-token={str ? (colon ? 'key' : 'string') : lit ? 'literal' : 'number'}
      >
        {str ?? whole}
      </span>,
    );
    if (colon) out.push(colon);
    last = at + whole.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function JsonViewer({
  value,
  label = 'JSON',
  ...rest
}: { value: unknown } & Omit<CodeBlockProps, 'code'>) {
  const code = JSON.stringify(value, null, 2) ?? 'undefined';
  return (
    <Frame code={code} label={label} {...rest}>
      {tintJson(code)}
    </Frame>
  );
}
