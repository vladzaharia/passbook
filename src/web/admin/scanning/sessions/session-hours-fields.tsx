import { zoneLabel } from '@/web/lib/timezones.ts';
import { Callout, SwitchRow, WeekGrid } from '@/web/ui/index.ts';
import type { SessionDraft } from './draft.ts';
import { DEFAULT_HOURS, hoursProblem } from './session-hours.ts';

/** "Open at set hours": the week the session scans, by its own clock; outside it, doors read Closed. */
export function SessionHoursFields({
  draft,
  set,
}: {
  draft: SessionDraft;
  set: (patch: Partial<SessionDraft>) => void;
}) {
  const problem = hoursProblem(draft.hoursOn, draft.hours);
  return (
    <section className="grid gap-3" aria-label="Hours">
      <SwitchRow
        label="Open at set hours"
        help="Opens and closes by itself. Pause or end still stops it."
        checked={draft.hoursOn}
        onCheckedChange={(hoursOn) =>
          set({ hoursOn, hours: hoursOn ? (draft.hours ?? DEFAULT_HOURS) : draft.hours })
        }
      />
      {draft.hoursOn ? (
        <>
          <p className="text-xs text-fg-muted">
            Times are in {zoneLabel(draft.timeZone)}. A span that ends before it starts runs past
            midnight.
          </p>
          <WeekGrid
            label="Session"
            hours={draft.hours}
            mergeKey="session-hours"
            onChange={(hours) => set({ hours })}
          />
          {problem ? <Callout tone="warning">{problem}</Callout> : null}
        </>
      ) : null}
    </section>
  );
}
