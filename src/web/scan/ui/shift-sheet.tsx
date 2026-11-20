import { useQuery } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import type { z } from 'zod';
import type { ScanReason } from '@/shared/contracts/scan.ts';
import type { ScanSummarySchema } from '@/shared/contracts/scan-session.ts';
import { SCAN_REASON_COPY } from '@/shared/copy/scan.ts';
import { formatCount, formatTime } from '../../lib/format.ts';
import { Buddy } from '../../ui/art/buddy.tsx';
import { Button } from '../../ui/button.tsx';
import { ErrorState } from '../../ui/error-state.tsx';
import { Sheet, SheetContent } from '../../ui/sheet.tsx';
import type { ScanApi } from '../api/scan-api.ts';
import type { ScanState } from '../machine/types.ts';
import type { QueueView } from '../offline/queue-view.ts';
import { OfflineStatus } from './offline-status.tsx';

type Summary = z.infer<typeof ScanSummarySchema>;
type Scope = 'device' | 'session';

const VALUE_LABEL = { add: 'Added', take: 'Taken', set: 'Set', use_up: 'Used up' } as const;

const reasonLabel = (reason: string) =>
  SCAN_REASON_COPY[reason as ScanReason]?.headline.replace(/\s*\{.*$/, '') ?? reason;

function Rows({
  title,
  rows,
}: {
  title: string;
  rows: { key: string; label: string; value: string }[];
}) {
  if (!rows.length) return null;
  return (
    <section className="flex flex-col gap-2" aria-label={title}>
      <h3 className="text-sm font-semibold text-fg-muted">{title}</h3>
      <ul className="flex flex-col gap-1">
        {rows.map((row) => (
          <li key={row.key} className="flex justify-between gap-3">
            <span>{row.label}</span>
            <strong className="tabular-nums">{row.value}</strong>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Totals({ summary, timeZone }: { summary: Summary; timeZone: string | null }) {
  return (
    <>
      <dl className="grid grid-cols-2 gap-4">
        {[
          ['Scans', summary.total],
          ['Done', summary.ok],
          ['Heads-up', summary.headsUp],
          ['Refused', summary.refused],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="text-sm text-fg-muted">{label}</dt>
            <dd className="text-3xl font-semibold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <Rows
        title="By action"
        rows={summary.byAction.map((a) => ({
          key: a.actionId,
          label: a.label,
          value: formatCount(a.count),
        }))}
      />
      <Rows
        title="Value"
        rows={summary.byValue.map((v) => ({
          key: v.kind,
          label: `${VALUE_LABEL[v.kind]} (${formatCount(v.count)})`,
          value: formatCount(v.amount),
        }))}
      />
      <Rows
        title="By hour"
        rows={summary.byHour.map((h) => ({
          key: String(h.start),
          label: formatTime(h.start, timeZone ?? undefined),
          value: formatCount(h.count),
        }))}
      />
      <Rows
        title="Not accepted"
        rows={summary.byReason.map((r) => ({
          key: r.reason,
          label: reasonLabel(r.reason),
          value: formatCount(r.count),
        }))}
      />
      <Rows
        title="By staff"
        rows={summary.byStaff.map((s) => ({
          key: s.staffId ?? 'none',
          label: s.name ?? 'No one signed in',
          value: `${formatCount(s.count)}${s.overrides ? ` · ${s.overrides} overrides` : ''}`,
        }))}
      />
    </>
  );
}

/** What the next person should know: the overrides of this shift, newest first. */
function Handover({ summary, timeZone }: { summary: Summary; timeZone: string | null }) {
  const { count, latest } = summary.overrides;
  return (
    <section className="flex flex-col gap-2" aria-label="Handover">
      <h3 className="text-sm font-semibold text-fg-muted">Handover</h3>
      {count ? (
        <>
          <p>
            {count} {count === 1 ? 'override' : 'overrides'} this shift.
          </p>
          <ul className="flex flex-col gap-1 text-sm">
            {latest.map((o) => (
              <li key={o.scanId}>
                {formatTime(o.at, timeZone ?? undefined)} ·{' '}
                {o.approvedBy ?? o.staffName ?? 'Unknown'}
                {o.reason ? ` · ${reasonLabel(o.reason)}` : ''}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p>No overrides this shift.</p>
      )}
    </section>
  );
}

export function ShiftSheet({
  open,
  ending,
  api,
  since,
  sessionTotals = false,
  onClose,
  onEnd,
  pending,
  offline,
  focus,
}: {
  open: boolean;
  ending: boolean;
  /** `queue`: scrolled to the offline queue when it opens (the strip's View). */
  focus?: 'queue';
  api: ScanApi;
  since: number;
  /** A Manager in a session may switch to the whole session's totals. */
  sessionTotals?: boolean;
  onClose: () => void;
  onEnd: () => void;
  pending: number;
  /** The offline mode, the list's age and what is queued; absent in tests that do not care. */
  offline?: {
    state: ScanState['offline'];
    queue: ScanState['queue'];
    onSync: () => void;
    /** What is saved on the device, read through the offline helpers. */
    rows?: () => Promise<QueueView[]>;
  };
}) {
  const [scope, setScope] = useState<Scope>('device');
  const query = useQuery({
    queryKey: ['scan', 'shift', since, scope],
    queryFn: ({ signal }) => api.summary(since, { signal }, scope),
    enabled: open,
    staleTime: 0,
    gcTime: 0,
  });
  const toQueue = useCallback(
    (el: HTMLElement | null) => {
      if (el && focus === 'queue') el.scrollIntoView?.({ block: 'start' });
    },
    [focus],
  );
  const summary = query.data;
  const timeZone = summary?.timeZone ?? null;
  return (
    <Sheet
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <SheetContent title={ending ? 'End shift?' : 'This shift'} className="scan-detail-sheet">
        <div className="flex flex-col gap-5 p-5">
          <Buddy scene="scan" pose="count" size="lg" mood="happy" />
          <p className="text-sm text-fg-muted">Since {formatTime(since, timeZone ?? undefined)}</p>
          {sessionTotals ? (
            <fieldset className="flex gap-2">
              <legend className="sr-only">Totals for</legend>
              {(['device', 'session'] as const).map((value) => (
                <Button
                  key={value}
                  variant={scope === value ? 'primary' : 'secondary'}
                  aria-pressed={scope === value}
                  onClick={() => setScope(value)}
                >
                  {value === 'device' ? 'This device' : 'This session'}
                </Button>
              ))}
            </fieldset>
          ) : null}
          {offline ? (
            <div ref={toQueue} className="scroll-mt-4">
              <OfflineStatus
                offline={offline.state}
                queue={offline.queue}
                {...(timeZone ? { timeZone } : {})}
                {...(offline.rows ? { rows: offline.rows } : {})}
                onSync={offline.onSync}
              />
            </div>
          ) : null}
          {query.isError ? (
            <ErrorState error={query.error} onRetry={() => query.refetch()} />
          ) : null}
          {summary ? <Totals summary={summary} timeZone={timeZone} /> : null}
          {ending ? (
            <>
              {summary ? <Handover summary={summary} timeZone={timeZone} /> : null}
              <p className="text-sm">
                This device stays paired. Start a new shift when you’re ready.
              </p>
              {pending ? (
                <p role="status">{pending} scans need confirmation. Keep this shift open.</p>
              ) : null}
              <Button disabled={pending > 0} onClick={onEnd}>
                End shift
              </Button>
              <Button variant="secondary" onClick={onClose}>
                Keep scanning
              </Button>
            </>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
