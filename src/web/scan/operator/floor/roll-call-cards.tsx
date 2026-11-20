import { Check, LogOut, Monitor, Printer, Siren } from 'lucide-react';
import type { RollCall, RollCallPerson } from '../../../../shared/contracts/scan-roll-call.ts';
import { OPERATOR_COPY } from '../../../../shared/copy/scan-operator.ts';
import { Button } from '../../../ui/button.tsx';
import { fill } from '../../ui/copy.ts';
import { ACCESS_COPY } from '../../ui/copy-access.ts';
import { Kbd } from '../workspace/command-field.tsx';
import './roll-call-strip.css';
import { Bar, Card } from './floor-cards.tsx';
import { byDevice, byZone } from './floor-model.ts';

const F = OPERATOR_COPY.floor;
const V = OPERATOR_COPY.views;

/** Confirmed against listed in each zone: where the call is still short. */
export function ByZoneCard({ call }: { call: RollCall }) {
  return (
    <Card icon={<Siren aria-hidden />} title={F.byZone} meta={F.confirmed}>
      <ul className="op-fl-places">
        {byZone(call).map((z) => (
          <li key={z.name} className="op-fl-place" data-done={z.marked >= z.total || undefined}>
            <span className="op-fl-place-name">{z.name}</span>
            <b className="op-fl-count">
              {z.marked} <small>{fill(F.ofTotal, { total: z.total })}</small>
            </b>
            <Bar value={z.marked} max={z.total} full={false} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Which desk marked how many, so the room can see who is working the list. */
export function OnCallCard({ call }: { call: RollCall }) {
  const rows = byDevice(call);
  return (
    <Card icon={<Monitor aria-hidden />} title={F.onCall}>
      {rows.length ? (
        <ul className="op-fl-devices">
          {rows.map((r) => (
            <li key={r.by}>
              <span className="op-fl-device" title={r.by}>
                {r.by}
              </span>
              <span className="op-fl-state">{fill(F.marked, { n: r.count })}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="op-fl-note">{fill(F.marked, { n: 0 })}</p>
      )}
    </Card>
  );
}

export function RollCallActions({
  finished,
  busy,
  onPrint,
  onEnd,
}: {
  finished: boolean;
  busy: boolean;
  onPrint: () => void;
  onEnd: () => void;
}) {
  return (
    <div className="op-fl-actions">
      <Button variant="outline" iconStart={<Printer aria-hidden />} onClick={onPrint}>
        {V.print}
      </Button>
      <Button variant={finished ? 'primary' : 'danger'} disabled={busy} onClick={onEnd}>
        {ACCESS_COPY.roll.end}
      </Button>
    </div>
  );
}

/**
 * Above the open person while a call runs: whether they are confirmed, and Safe, Out and Next.
 * The keys are the call's: S, X and the arrow, the same as the buttons.
 */
export function RollCallStrip({
  person,
  place,
  seen,
  onMark,
  onNext,
}: {
  person: RollCallPerson;
  place: string;
  seen: string;
  onMark: (status: 'present' | 'out' | 'none') => void;
  onNext: () => void;
}) {
  const status = person.mark?.status;
  const safe = status === 'present';
  const out = status === 'out';
  return (
    <fieldset
      className="op-rc-strip"
      data-state={safe ? 'safe' : out ? 'out' : 'open'}
      aria-label={V.rollTitle}
    >
      <p className="op-rc-band">
        <b>{safe ? V.safe : out ? V.out : V.notConfirmed}</b>
        <span>
          {person.mark?.by
            ? fill(ACCESS_COPY.roll.by, { name: person.mark.by })
            : fill(V.lastSeen, { place, time: seen })}
        </span>
      </p>
      <div className="op-rc-keys">
        <Button
          variant={safe ? 'secondary' : 'primary'}
          aria-pressed={safe}
          aria-keyshortcuts="S"
          iconStart={<Check aria-hidden />}
          onClick={() => onMark(safe ? 'none' : 'present')}
        >
          {V.safe} <Kbd>S</Kbd>
        </Button>
        <Button
          variant="outline"
          aria-pressed={out}
          aria-keyshortcuts="X"
          iconStart={<LogOut aria-hidden />}
          onClick={() => onMark(out ? 'none' : 'out')}
        >
          {V.out} <Kbd>X</Kbd>
        </Button>
        <Button variant="ghost" onClick={onNext}>
          {V.rollNext}
        </Button>
      </div>
    </fieldset>
  );
}
