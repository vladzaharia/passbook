import type { z } from 'zod';
import type { RulePreviewSchema } from '@/shared/contracts/message-rules.ts';
import { RULE_COPY } from '@/shared/copy/message-rules.ts';
import { plural } from '@/shared/plural.ts';
import { formatCalendarDate, formatCount } from '../../lib/format.ts';
import { Skeleton } from '../../ui/index.ts';

type Preview = z.infer<typeof RulePreviewSchema>;

/** Passes due each of the next 14 days, for the rule as typed. */
export function RulePreview({
  data,
  blocked,
  loading,
}: {
  data: Preview | undefined;
  /** The rule is not complete enough to count. */
  blocked: boolean;
  loading: boolean;
}) {
  if (blocked && !data)
    return <p className="text-sm text-fg-muted">Finish the rule to see who is due.</p>;
  if (!data) return loading ? <Skeleton className="h-16 w-full" /> : null;
  const days = data.days.filter((d) => d.count > 0);
  return (
    <div aria-live="polite" className="flex flex-col gap-2">
      <p className="text-sm font-medium text-fg-strong">
        Next 14 days: {plural(data.total, 'pass', 'passes')}
      </p>
      {days.length === 0 ? (
        <p className="text-sm text-fg-muted">{RULE_COPY.nobodyDue}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {days.map((d) => (
            <li key={d.date} className="flex justify-between gap-3 px-3 py-1.5 text-sm">
              <span>{formatCalendarDate(d.date)}</span>
              <span className="tabular-nums text-fg-muted">{formatCount(d.count)}</span>
            </li>
          ))}
        </ul>
      )}
      {data.atLimit > 0 ? (
        <p className="text-xs text-fg-muted">
          {formatCount(data.atLimit)} {data.atLimit === 1 ? 'is' : 'are'} at today's limit now and
          may send later.
        </p>
      ) : null}
    </div>
  );
}
