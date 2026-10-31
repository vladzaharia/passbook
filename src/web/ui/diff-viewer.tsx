import { useMemo } from 'react';
import { diffLines } from '../lib/diff.ts';
import { cn } from '../lib/cn.ts';

export interface DiffViewerProps {
  before: string;
  after: string;
  className?: string;
}

const MARK = { same: ' ', add: '+', del: '-' } as const;
const WORD = { same: '', add: 'Added: ', del: 'Removed: ' } as const;

export function DiffViewer({ before, after, className }: DiffViewerProps) {
  const lines = useMemo(() => diffLines(before, after), [before, after]);
  const changed = lines.some((l) => l.kind !== 'same');
  if (!changed) return <p className="text-sm text-fg-muted">No changes</p>;
  return (
    <pre
      // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region
      tabIndex={0}
      aria-label="Diff"
      className={cn('max-h-96 overflow-auto rounded-md border border-border bg-surface-sunken py-2 font-mono text-xs', className)}
    >
      {lines.map((line, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity
          key={i}
          className={cn(
            'px-3 whitespace-pre-wrap',
            line.kind === 'add' && 'bg-success-subtle text-success',
            line.kind === 'del' && 'bg-danger-subtle text-danger',
            line.kind === 'same' && 'text-fg-muted',
          )}
        >
          <span className="sr-only">{WORD[line.kind]}</span>
          <span aria-hidden>{MARK[line.kind]} </span>
          {line.text}
        </div>
      ))}
    </pre>
  );
}
