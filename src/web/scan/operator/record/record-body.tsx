import { Info } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { DisplayPanels } from '../../display/display-panels.tsx';
import type { Draft, ScanOutcome } from '../../machine/types.ts';
import { ValuePicker } from '../../result/value-picker.tsx';
import { FamilyBlock } from './family-block.tsx';
import { type Fact, factsOf } from './record-facts.ts';
import { displayOf } from './record-model.ts';

const PassPreview = lazy(() =>
  import('../../result/pass-preview.tsx').then((m) => ({ default: m.PassPreview })),
);

export interface PickerDesk {
  picker: Draft | null;
  onAmount: (value: number) => void;
  onValue: (value: unknown) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/** A refusal or a hold changed nothing: no stamp, balance or staff note that could read as granted. */
export const deniedOf = (o: ScanOutcome): boolean =>
  o.kind === 'refused' || (o.kind === 'heads_up' && (Boolean(o.access) || Boolean(o.occupancy)));

function notesOf(o: ScanOutcome, eventNote: string | null | undefined): string[] {
  const d = displayOf(o);
  const denied = deniedOf(o);
  return [
    ...new Set(
      [
        o.kind === 'refused' ? d?.notes.refused : denied ? null : d?.notes.staff,
        o.kind === 'refused' || o.kind === 'heads_up' ? eventNote : null,
      ].filter((n): n is string => Boolean(n)),
    ),
  ];
}

/** Why a refusal or a hold, in the pass's own terms: the template shows nothing on a refused screen. */
function Facts({ facts }: { facts: Fact[] }) {
  return (
    <dl className="op-facts" data-testid="op-facts">
      {facts.map((f) => (
        <div key={f.label}>
          <dt>{f.label}</dt>
          <dd>{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The pass: its desk display as tiles, the value picker when one is open, and the family beside it. */
export function RecordBody({
  outcome: o,
  desk,
  orgId,
  timeZone,
  eventNote,
}: {
  outcome: ScanOutcome;
  desk: PickerDesk | undefined;
  orgId: string | undefined;
  timeZone: string | undefined;
  eventNote: string | null | undefined;
}) {
  const d = displayOf(o);
  const denied = deniedOf(o);
  const notes = notesOf(o, eventNote);
  const facts = denied ? factsOf(o, timeZone) : [];
  const picker = o.kind === 'ready' && o.card && desk?.picker ? desk.picker : null;
  const left = picker || (d && !denied && !o.group) || notes.length > 0 || facts.length > 0;
  const right = Boolean(o.bundle ?? o.card?.bundle ?? o.group) || Boolean(o.card?.passView);
  if (!left && !right) return null;
  return (
    <div className="op-rec-body" data-cols={left && right ? 2 : 1}>
      {left ? (
        <div className="op-col">
          {picker && o.card && desk ? (
            <ValuePicker
              card={o.card}
              draft={picker}
              onAmount={desk.onAmount}
              onValue={desk.onValue}
              onConfirm={desk.onConfirm}
              onCancel={desk.onCancel}
            />
          ) : d && !denied && !o.group ? (
            <DisplayPanels display={d} />
          ) : facts.length ? (
            <Facts facts={facts} />
          ) : null}
          {notes.length ? (
            <div className="op-note">
              <Info aria-hidden />
              <div>
                {notes.map((note) => (
                  <p key={note}>{note}</p>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      {right ? (
        <div className="op-col">
          <FamilyBlock outcome={o} />
          {o.card ? (
            <div className="op-rec-pass">
              <Suspense fallback={<div className="scan-pass-preview" aria-hidden />}>
                <PassPreview
                  card={o.card}
                  {...(orgId ? { orgId } : {})}
                  {...(timeZone ? { timeZone } : {})}
                  still
                />
              </Suspense>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
