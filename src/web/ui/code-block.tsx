import { cn } from '../lib/cn.ts';
import { CopyButton } from './copy-button.tsx';

export interface CodeBlockProps {
  code: string;
  label?: string;
  className?: string;
  maxHeight?: string;
}

export function CodeBlock({ code, label = 'Code', className, maxHeight = 'max-h-96' }: CodeBlockProps) {
  return (
    <div className={cn('relative rounded-md border border-border bg-surface-sunken', className)}>
      <div className="absolute top-1 right-1">
        <CopyButton value={code} label={`Copy ${label.toLowerCase()}`} />
      </div>
      {/* Focusable so keyboard users can scroll it. */}
      <pre
        // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region
        tabIndex={0}
        aria-label={label}
        className={cn('overflow-auto p-3 pr-10 font-mono text-xs text-fg', maxHeight)}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function JsonViewer({
  value,
  label = 'JSON',
  ...rest
}: { value: unknown } & Omit<CodeBlockProps, 'code'>) {
  return <CodeBlock code={JSON.stringify(value, null, 2) ?? 'undefined'} label={label} {...rest} />;
}
