import { DependentSettings, FormField, Input, NumberField, SwitchRow } from '@/web/ui/index.ts';
import { withTrack, type ZoneDraft } from './zone-draft.ts';

export interface OccupancyErrors {
  capacity?: string;
  maxStay?: string;
  clearAt?: string;
}

/** The zone wizard's Occupancy step: tracking, tap out, and the limits that need it. */
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
  return (
    <div className="@container flex flex-col gap-4">
      {inNow !== null ? (
        <p role="status" className="text-xs text-fg-muted">
          {inNow} inside now.
        </p>
      ) : null}
      <SwitchRow
        label="Track who’s inside"
        checked={draft.track}
        onCheckedChange={(track) => set(withTrack(draft, track))}
      />
      <DependentSettings open={draft.track}>
        <SwitchRow
          label="Require tap out"
          help="A second entry waits for a tap-out. Put an Out or Both scanner at the exit."
          checked={draft.enforce}
          onCheckedChange={(enforce) => set({ ...draft, enforce })}
        />
        <SwitchRow
          label="Hard limit"
          help="Full is final: no one can let anyone in, whatever their role. Needs a capacity."
          checked={draft.hardLimit}
          disabled={draft.capacity === null}
          onCheckedChange={(hardLimit) => set({ ...draft, hardLimit })}
        />
        <div className="grid gap-4 @[30rem]:grid-cols-3">
          <FormField
            label="Capacity"
            error={errors.capacity}
            help="Full stops new entries. Staff can let someone in, unless Hard limit is on."
          >
            {(p) => (
              <NumberField
                {...p}
                unit="people"
                className="w-full"
                min={1}
                max={100000}
                value={draft.capacity}
                onValueChange={(capacity) =>
                  set({
                    ...draft,
                    capacity,
                    hardLimit: capacity === null ? false : draft.hardLimit,
                  })
                }
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
                value={draft.clearAt}
                onChange={(e) => set({ ...draft, clearAt: e.target.value })}
              />
            )}
          </FormField>
        </div>
      </DependentSettings>
    </div>
  );
}
