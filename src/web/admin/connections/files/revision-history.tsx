import { useState } from 'react';
import { formatDateTime, pluralize } from '../../../lib/format.ts';
import { Badge, Button, Card, CardHeader } from '../../../ui/index.ts';
import { diffLine, type Revision, statusOf } from './status.ts';

const FIRST = 3;

/** Every revision, newest first: three at a time to start. */
export function RevisionHistory({
  revisions,
  applyingId,
}: {
  revisions: readonly Revision[];
  /** The revision a run is applying now. */
  applyingId?: string | undefined;
}) {
  const [all, setAll] = useState(false);
  if (revisions.length === 0) return null;
  const shown = all ? revisions : revisions.slice(0, FIRST);
  return (
    <Card>
      <CardHeader title="History" />
      <ul className="divide-y divide-border">
        {shown.map((r) => {
          const status =
            r.id === applyingId ? { label: 'Applying', tone: 'info' as const } : statusOf(r);
          return (
            <li key={r.id} className="flex min-w-0 flex-col gap-1 px-4 py-3">
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <p className="min-w-0 text-sm font-medium break-all text-fg-strong">
                  Revision {r.revision}
                  <span className="font-normal text-fg-muted"> · {r.name}</span>
                </p>
                <Badge tone={status.tone}>{status.label}</Badge>
              </div>
              <p className="text-xs text-fg-muted">
                {pluralize(r.rows, 'row')} · {formatDateTime(r.createdAt)}
                {r.createdByName ? ` by ${r.createdByName}` : ''}
                {diffLine(r) ? ` · ${diffLine(r)}` : ''}
              </p>
            </li>
          );
        })}
      </ul>
      {revisions.length > FIRST ? (
        <div className="border-t border-border p-2">
          <Button variant="ghost" size="sm" onClick={() => setAll(!all)}>
            {all ? 'Show fewer' : `Show all ${revisions.length}`}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
