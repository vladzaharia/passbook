import { FormField, Input, NumberField, SwitchRow } from '@/web/ui/index.ts';
import { withTrack, type ZoneDraft } from './zone-draft.ts';

export interface OccupancyErrors {
  capacity?: string;
  maxStay?: string;
  clearAt?: string;
}

/** The zone dialog's Occupancy section: tracking, tap out, and the limits that need it. */
export function OccupancyFields({
  draft,
  set,
  errors,
  inNow,
}: {
  draft: ZoneDraft;
  set: (next: ZoneDraft) => void;
  errors: OccupancyErrors;
  inNow: number | null;
}) {
  const off = !draft.track;
  return (
    <section
      aria-labelledby="zone-occupancy"
      className="@container mt-2 grid gap-4 border-t border-border pt-6"
    >
      <div>
        <h3 id="zone-occupancy" className="text-sm font-semibold text-fg-strong">
          Occupancy
        </h3>
        {inNow !== null ? (
          <p role="status" className="mt-1 text-xs text-fg-muted">
            {inNow} inside now.
          </p>
        ) : null}
      </div>
      <SwitchRow
        label="Track who’s inside"
        help="Counts people in and out. Monitors show In now."
        checked={draft.track}
        onCheckedChange={(track) => set(withTrack(draft, track))}
      />
      <SwitchRow
        label="Require tap out"
        help="A second entry waits for a tap-out. Put an Out or Both scanner at the exit."
        checked={draft.enforce}
        disabled={off}
        onCheckedChange={(enforce) => set({ ...draft, enforce })}
      />
      <div className="grid gap-4 @[30rem]:grid-cols-3">
        <FormField
          label="Capacity"
          error={errors.capacity}
          help="Full stops new entries. A Manager can let someone in."
        >
          {(p) => (
            <NumberField
              {...p}
              unit="people"
              className="w-full"
              min={1}
              max={100000}
              disabled={off}
              value={draft.capacity}
              onValueChange={(capacity) => set({ ...draft, capacity })}
            />
          )}
        </FormField>
        <FormField
          label="Max stay"
          error={errors.maxStay}
          help="Anyone still in after this is tapped out."
        >
          {(p) => (
            <NumberField
              {...p}
              unit="min"
              className="w-full"
              min={15}
              max={2880}
              disabled={off}
              value={draft.maxStayMinutes}
              onValueChange={(maxStayMinutes) => set({ ...draft, maxStayMinutes })}
            />
          )}
        </FormField>
        <FormField
          label="Clear at"
          error={errors.clearAt}
          help="Everyone still in is tapped out at this time, in the top zone’s time zone. Needs one. Empty: never."
        >
          {(p) => (
            <Input
              {...p}
              type="time"
              disabled={off}
              value={draft.clearAt}
              onChange={(e) => set({ ...draft, clearAt: e.target.value })}
            />
          )}
        </FormField>
      </div>
    </section>
  );
}
