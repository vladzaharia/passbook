import type { ScanCounts } from '../../../../shared/contracts/scan.ts';
import { OPERATOR_COPY } from '../../../../shared/copy/scan-operator.ts';
import { allConfirmed } from '../../roll-call/roll-call-model.ts';
import { inNowOf } from '../workspace/session-state.ts';
import { DevicesCard, InNowCard, ShiftCard } from './floor-cards.tsx';
import { ByZoneCard, OnCallCard, RollCallActions } from './roll-call-cards.tsx';
import type { RollControls } from './roll-call-dialogs.tsx';
import type { Floor as FloorData } from './use-floor.ts';
import './floor.css';

/**
 * The floor, at 1280 and up: what is happening around this desk. While a roll call runs it gives
 * way to the call's own cards. A Door scanner has the count and its shift only.
 */
export function Floor({
  floor,
  online,
  counts,
  shiftStart,
  now,
  timeZone,
  controls,
}: {
  floor: FloorData;
  online: boolean;
  counts: ScanCounts;
  shiftStart: number;
  now: number;
  timeZone?: string | undefined;
  controls: RollControls;
}) {
  const { roll, inside, devices, shift, hub, desk } = floor;
  const call = roll.call;
  if (call)
    return (
      <aside className="op-floor" aria-label={OPERATOR_COPY.floor.landmark}>
        <ByZoneCard call={call} />
        <OnCallCard call={call} />
        <RollCallActions
          finished={allConfirmed(call)}
          busy={roll.busy}
          onPrint={() => controls.setPrinting(true)}
          onEnd={() => controls.setConfirm('end')}
        />
      </aside>
    );
  const own = inNowOf(counts);
  const places = desk
    ? inside.state.places
    : own
      ? [
          {
            place: 'own',
            name: counts.place?.name ?? OPERATOR_COPY.floor.inNow,
            inNow: own.count,
            capacity: own.capacity,
            rev: 0,
          },
        ]
      : [];
  return (
    <aside className="op-floor" aria-label={OPERATOR_COPY.floor.landmark}>
      {places.length ? (
        <InNowCard
          places={places}
          lead={counts.place?.name ?? null}
          live={hub.up}
          asOf={desk ? inside.state.asOf : null}
          timeZone={timeZone}
          onStartRoll={desk ? () => controls.setConfirm('start') : undefined}
          rollDisabled={roll.busy || !online}
        />
      ) : null}
      <ShiftCard
        summary={shift.summary}
        since={shiftStart}
        timeZone={timeZone}
        failed={shift.failed}
      />
      {desk ? <DevicesCard items={devices.items} failed={devices.failed} now={now} /> : null}
    </aside>
  );
}
