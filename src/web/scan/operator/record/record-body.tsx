import { Info } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { OPERATOR_COPY } from '../../../../shared/copy/scan-operator.ts';
import type { ScanApi } from '../../api/scan-api.ts';
import { DisplayPanels } from '../../display/display-panels.tsx';
import type { Draft, ScanOutcome } from '../../machine/types.ts';
import { ValuePicker } from '../../result/value-picker.tsx';
import { FamilyBlock } from './family-block.tsx';
import { History } from './history.tsx';
import { Notes } from './notes.tsx';
import { type Fact, factsOf } from './record-facts.ts';
import { displayOf } from './record-model.ts';

const PassPreview = lazy(() =>
  import('../../result/pass-preview.tsx').then((m) => ({ default: m.PassPreview })),
);

/** What the person's history and staff notes need: who, which role, and when to read again. */
export interface PersonPanels {
  api: ScanApi;
  passId: string;
  zone: string | undefined;
  now: number;
  /** Changes when something new happened to this person. */
  refresh: unknown;
  /** Desk and above: changes and staff notes. */
  desk: boolean;
  /** Manager and above: any note may be changed. */
  manager: boolean;
  noteSignal: number;
  onNoteAdded: () => void;
}

export interface PickerDesk {
  picker: Draft | null;
  onAmount: (value: number | null) => void;
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
  person,
}: {
  outcome: ScanOutcome;
  desk: PickerDesk | undefined;
  orgId: string | undefined;
  timeZone: string | undefined;
  eventNote: string | null | undefined;
  person: PersonPanels | null;
}) {
  const d = displayOf(o);
  const denied = deniedOf(o);
  const notes = notesOf(o, eventNote);
  // Phone width folds Notes and History into two tabs; wider, both show and the tabs are hidden.
  const [tab, setTab] = useState<'notes' | 'history'>('notes');
  const noteSignal = person?.noteSignal;
  useEffect(() => {
    if (noteSignal) setTab('notes');
  }, [noteSignal]);
  const facts = denied ? factsOf(o, timeZone) : [];
  const picker = o.kind === 'ready' && o.card && desk?.picker ? desk.picker : null;
  const left =
    picker ||
    (d && !denied && !o.group) ||
    notes.length > 0 ||
    facts.length > 0 ||
    Boolean(person?.desk);
  const right =
    Boolean(o.bundle ?? o.card?.bundle ?? o.group) || Boolean(o.card?.passView) || Boolean(person);
  if (!left && !right) return null;
  return (
    <div className="op-rec-body" data-cols={left && right ? 2 : 1} data-tab={tab}>
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
          {person?.desk ? (
            <div role="tablist" className="op-rec-tabs" aria-label={OPERATOR_COPY.record.tabs}>
              {(['notes', 'history'] as const).map((id) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={tab === id}
                  className="op-rec-tab"
                  onClick={() => setTab(id)}
                >
                  {OPERATOR_COPY[id].heading}
                </button>
              ))}
            </div>
          ) : null}
          {person?.desk ? (
            <div data-pane="notes">
              <Notes
                api={person.api}
                passId={person.passId}
                openSignal={person.noteSignal}
                manager={person.manager}
                onAdded={person.onNoteAdded}
              />
            </div>
          ) : null}
        </div>
      ) : null}
      {right ? (
        <div className="op-col">
          <FamilyBlock outcome={o} />
          {person ? (
            <div data-pane="history">
              <History
                api={person.api}
                passId={person.passId}
                zone={person.zone}
                now={person.now}
                refresh={person.refresh}
                changes={person.desk}
              />
            </div>
          ) : null}
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
