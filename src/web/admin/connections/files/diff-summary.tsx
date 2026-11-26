import { TriangleAlert } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { z } from 'zod';
import type { ConnectionFileDiffSchema } from '@/shared/contracts/connection-files.ts';
import { cn } from '../../../lib/cn.ts';
import { CountUp } from '../../../ui/index.ts';

type Diff = z.infer<typeof ConnectionFileDiffSchema>;
export type OnMissing = 'keep' | 'flag' | 'void';

const KINDS = [
  { id: 'added', label: 'New', dot: 'bg-success' },
  { id: 'changed', label: 'Changed', dot: 'bg-info' },
  { id: 'removed', label: 'Removed', dot: 'bg-warning' },
] as const;

/** What a removed row does to its pass, in the connection's own rule. */
export const REMOVED_EFFECT: Record<OnMissing, string> = {
  flag: 'Their passes will be flagged for review.',
  void: 'Their passes will be voided and stop working in Wallet.',
  keep: 'Their passes stay as they are.',
};

function Refs({ refs, total }: { refs: readonly string[]; total: number }) {
  if (refs.length === 0) return null;
  return (
    <ul className="flex min-w-0 flex-wrap items-center gap-1.5">
      {refs.map((r) => (
        <li
          key={r}
          className="max-w-full truncate rounded-md border border-border bg-surface-sunken px-2 py-0.5 font-mono text-xs text-fg"
        >
          {r}
        </li>
      ))}
      {total > refs.length ? (
        <li className="text-xs text-fg-muted">+{total - refs.length} more</li>
      ) : null}
    </ul>
  );
}

/** New, changed and removed rows against the revision in use, with a few refs of each. */
export function DiffSummary({ diff, onMissing }: { diff: Diff; onMissing: OnMissing }) {
  const empty = diff.added + diff.changed + diff.removed === 0;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ul className="wl-deal grid grid-cols-3 gap-3">
        {KINDS.map((k, i) => (
          <li
            key={k.id}
            style={{ '--i': i } as CSSProperties}
            className="flex flex-col gap-1 rounded-lg border border-border bg-surface-raised p-3 sm:p-4"
          >
            <CountUp
              value={diff[k.id]}
              className="text-2xl font-semibold text-fg-strong sm:text-3xl"
            />
            <span className="flex items-center gap-2 text-sm text-fg-muted">
              <span aria-hidden className={cn('size-2 rounded-full', k.dot)} />
              {k.label}
            </span>
          </li>
        ))}
      </ul>
      {empty ? <p className="text-sm text-fg-muted">Same rows as the current file.</p> : null}
      {KINDS.filter((k) => k.id !== 'removed' && diff.examples[k.id].length > 0).map((k) => (
        <div key={k.id} className="flex min-w-0 flex-col gap-1.5">
          <p className="text-xs font-medium text-fg-muted">{k.label}</p>
          <Refs refs={diff.examples[k.id]} total={diff[k.id]} />
        </div>
      ))}
      {diff.removed > 0 ? (
        <div
          className={cn(
            'flex min-w-0 flex-col gap-2 rounded-lg border p-3',
            onMissing === 'keep'
              ? 'border-border bg-surface-sunken'
              : 'border-warning-border bg-warning-subtle',
          )}
        >
          <p className="flex items-center gap-2 text-sm font-medium text-fg-strong">
            <TriangleAlert aria-hidden className="size-4 shrink-0 text-warning" />
            {diff.removed === 1
              ? '1 row is not in the file'
              : `${diff.removed} rows are not in the file`}
          </p>
          <p className="text-sm text-fg">{REMOVED_EFFECT[onMissing]}</p>
          <Refs refs={diff.examples.removed} total={diff.removed} />
        </div>
      ) : null}
    </div>
  );
}
