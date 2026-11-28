import type { z } from 'zod';
import type { ScanReason } from '@/shared/contracts/scan.ts';
import type { ScanSummarySchema } from '@/shared/contracts/scan-session.ts';
import { SCAN_REASON_COPY } from '@/shared/copy/scan.ts';
import { SCAN_HANDHELD_COPY } from '@/shared/copy/scan-handheld.ts';
import { plural } from '@/shared/plural.ts';
import { formatCount, formatTime } from '../../lib/format.ts';
import type { Counts } from '../machine/types.ts';

const C = SCAN_HANDHELD_COPY.shift;
const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));

/** The door's count for the shift hero: the number, its caption and how full it is (null without capacity). */
export function shiftCount(counts: Counts | null) {
  if (!counts) return null;
  const e = counts.event;
  const total = e ? (e.capacity ?? e.expected) : null;
  const n = e ? e.arrived : counts.today;
  return {
    n: formatCount(n),
    caption: [total ? fill(C.of, { cap: formatCount(total) }) : null, e ? C.in : C.today]
      .filter(Boolean)
      .join(' '),
    pct: total ? Math.min(100, Math.round((n / total) * 100)) : null,
  };
}

/** What this person did in the shift. */
export function shiftYou(summary: Summary): string {
  return fill(C.you, { in: summary.ok, refused: summary.refused, undone: summary.undone });
}

export type Summary = z.infer<typeof ScanSummarySchema>;
export type Scope = 'device' | 'session';

const VALUE_LABEL = { add: 'Added', take: 'Taken', set: 'Set', use_up: 'Used up' } as const;

export const reasonLabel = (reason: string) =>
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

export function Totals({ summary, timeZone }: { summary: Summary; timeZone: string | null }) {
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
export function Handover({ summary, timeZone }: { summary: Summary; timeZone: string | null }) {
  const { count, latest } = summary.overrides;
  return (
    <section className="flex flex-col gap-2" aria-label="Handover">
      <h3 className="text-sm font-semibold text-fg-muted">Handover</h3>
      {count ? (
        <>
          <p>{plural(count, 'override')} this shift.</p>
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
