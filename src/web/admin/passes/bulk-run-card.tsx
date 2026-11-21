import { useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useEffect } from 'react';
import { formatCount } from '../../lib/format.ts';
import { Button, ProgressBar } from '../../ui/index.ts';
import { passKeys } from './api.ts';
import { useBulkRun, useStopBulkRun } from './find-api.ts';

const VERB = { void: 'Voiding', send_email: 'Emailing', remove: 'Removing' } as const;
const DONE = { void: 'voided', send_email: 'emailed', remove: 'removed' } as const;

/**
 * A bulk run over every pass a filter matched: the bar while it goes (with Stop), then what it did.
 * Passes it skipped are counted, never hidden.
 */
export function BulkRunCard({
  id,
  orgId,
  onDismiss,
}: {
  id: string;
  orgId: string | undefined;
  onDismiss: () => void;
}) {
  const run = useBulkRun(id, orgId);
  const stop = useStopBulkRun(orgId);
  const qc = useQueryClient();
  const r = run.data;
  const active = r?.state === 'queued' || r?.state === 'running';
  // The passes changed under the list: read them again once the run ends.
  useEffect(() => {
    if (r && !active) void qc.invalidateQueries({ queryKey: passKeys.all });
  }, [r, active, qc]);
  if (!r) return null;
  const handled = r.done + r.skipped;
  const skipped = r.skipped ? ` · ${formatCount(r.skipped)} skipped` : '';
  return (
    <section
      aria-label="Bulk run"
      className="wl-find-banner mb-3 flex flex-col gap-2 rounded-md border border-border bg-surface-raised p-3 text-sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        <p role="status" className="mr-auto font-medium text-fg-strong tabular-nums">
          {active
            ? `${VERB[r.action]} ${formatCount(handled)} of ${formatCount(r.total)}`
            : r.state === 'done'
              ? `${formatCount(r.done)} ${DONE[r.action]}${skipped}`
              : r.state === 'stopped'
                ? `Stopped. ${formatCount(r.done)} ${DONE[r.action]}${skipped}`
                : `Stopped early. ${formatCount(r.done)} ${DONE[r.action]}${skipped}`}
        </p>
        {active ? (
          <Button
            variant="outline"
            size="sm"
            loading={stop.isPending}
            disabled={r.stopRequested}
            onClick={() => stop.mutate(r.id)}
          >
            {r.stopRequested ? 'Stopping' : 'Stop'}
          </Button>
        ) : (
          <Button variant="ghost" size="sm" iconStart={<X aria-hidden />} onClick={onDismiss}>
            Dismiss
          </Button>
        )}
      </div>
      {active ? (
        <ProgressBar
          label="Passes handled"
          value={handled}
          max={r.total}
          valueText={`${formatCount(handled)} of ${formatCount(r.total)} passes`}
        />
      ) : null}
      {!active && r.state === 'failed' ? (
        <p className="text-fg-muted">The run could not go on. Start it again for the rest.</p>
      ) : null}
    </section>
  );
}
