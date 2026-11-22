import type { z } from 'zod';
import type { ChangeRunPreviewSchema } from '@/shared/contracts/broadcasts-change.ts';

type Samples = z.infer<typeof ChangeRunPreviewSchema>['samples'];

/** Real passes with what would change: label, was, and will be. Empty is a dash, never raw JSON. */
export function SampleDiffs({ samples }: { samples: Samples }) {
  if (samples.length === 0) return null;
  return (
    <ul className="wl-stagger flex flex-col gap-2">
      {samples.map((s, i) => (
        <li
          key={s.passId}
          style={{ '--i': i } as React.CSSProperties}
          className="rounded-lg border border-border bg-surface-raised p-3"
        >
          <p className="truncate text-sm font-medium text-fg-strong">
            {s.title ?? 'Untitled pass'}
          </p>
          {s.changes.length === 0 ? (
            <p className="text-xs text-fg-muted">Already set</p>
          ) : (
            <dl className="mt-1 grid gap-0.5 text-sm">
              {s.changes.map((c) => (
                <div key={c.key} className="flex flex-wrap items-baseline gap-x-2">
                  <dt className="text-fg-muted">{c.label}</dt>
                  <dd className="min-w-0 break-words">
                    <span className="text-fg-muted line-through decoration-fg-subtle">
                      {c.from ?? 'Empty'}
                    </span>
                    {' → '}
                    <span className="font-medium text-fg-strong">{c.to ?? 'Empty'}</span>
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </li>
      ))}
    </ul>
  );
}
