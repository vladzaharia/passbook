import { useEffect, useRef, useState } from 'react';
import type { ScanSession } from '../../../../shared/contracts/scan-session.ts';
import { OPERATOR_COPY } from '../../../../shared/copy/scan-operator.ts';
import { Callout } from '../../../ui/callout.tsx';
import type { ScanApi } from '../../api/scan-api.ts';
import type { MachineEvent } from '../../machine/access-events.ts';
import type { ScanBuddyView } from '../../machine/present.ts';
import type { Loop, ScanOutcome } from '../../machine/types.ts';
import type { ScanRuntime } from '../../platform/runtime.ts';
import type { Command } from '../keys.ts';
import type { GateClock } from '../keys-gate.ts';
import type { RecordRef } from '../operator-model.ts';
import { focusHeading } from '../workspace/focus.ts';
import { type PinDesk, PinDialog } from './pin-dialog.tsx';
import { RecordActions } from './record-actions.tsx';
import { RecordBand } from './record-band.tsx';
import { type PersonPanels, type PickerDesk, RecordBody } from './record-body.tsx';
import { RecordBuddy } from './record-buddy.tsx';
import { markOutPlace } from './record-facts.ts';
import { PhotoSlot, RecordIdentity } from './record-identity.tsx';
import {
  type Act,
  actionsOf,
  bandOf,
  displayOf,
  identityOf,
  presenceOf,
  type Rights,
  rightsOf,
  type Source,
} from './record-model.ts';
import { useMarkOut } from './use-mark-out.ts';
import { useQuietShortcut } from './use-quiet-shortcut.ts';
import { useResolved } from './use-resolved.ts';
import { useRunAct } from './use-run-act.ts';
import './record.css';
import './record-band.css';
import './record-body.css';

const R = OPERATOR_COPY.record;

/** The pass a machine answer is of: the card it held, the read's own pass, else the card the answer carries. */
export function passIdOf(loop: Loop, outcome: ScanOutcome): string | null {
  const held = 'card' in loop ? loop.card : null;
  return (
    held?.passId ??
    ('input' in loop ? loop.input.passId : undefined) ??
    outcome.card?.passId ??
    null
  );
}

export interface RecordContext {
  api: ScanApi;
  runtime: ScanRuntime;
  session: ScanSession;
  timeZone: string | undefined;
  clock: number;
  keys: { current: ((command: Command) => boolean) | null };
  /** The machine's events: a scan's own actions go through it. */
  machine: (event: MachineEvent) => void;
  /** Undo this scan, when this device may and it is still in time. */
  undo: (() => void) | null;
  /** Leave the list's record before the machine takes over. */
  release: () => void;
  /** Hand a letter back to search as typing. */
  type: (text: string) => void;
  /** The key gate's clock, for the shortcut's extra wait; the real one by default. */
  quiet?: GateClock;
  /** This device's buddy for the answer on screen; null when there is none. */
  buddy: ScanBuddyView | null;
  /** Open the person's own record, or search for them by name, ending the scan card first. */
  showPass: (passId: string) => void;
  lookUp: (q: string) => void;
}

type Desk = PinDesk & PickerDesk;

function RecordView({
  ctx,
  outcome: o,
  source,
  passId,
  desk,
}: {
  ctx: RecordContext;
  outcome: ScanOutcome;
  source: Source;
  /** The pass this record is of; a verdict from a code carries it only when the machine knew it. */
  passId: string | null;
  desk?: Desk | undefined;
}) {
  const { api, session, machine, runtime } = ctx;
  const rights: Rights = rightsOf(session);
  const who = identityOf(o);
  const place = markOutPlace(o);
  const photoInput = useRef<HTMLInputElement | null>(null);
  const [pin, setPin] = useState(false);
  const noPhoto = !displayOf(o)?.identity.photo?.url && o.kind !== 'refused';
  const [exited, setExited] = useState(false);
  const [noteSignal, setNoteSignal] = useState(0);
  const [noteTick, setNoteTick] = useState(0);
  const mayAct = passId !== null;
  const addPhoto = rights.photo && noPhoto && mayAct;
  const actions = actionsOf(o, {
    source,
    rights,
    passId,
    name: who?.name ?? null,
    addPhoto,
    markOut: mayAct && place !== null && !exited,
  });
  // A card the server made read-only has nothing to choose: no band asking, no slot to fill.
  const band =
    actions.viewOnly && source === 'scan' && o.kind === 'ready'
      ? null
      : bandOf(o, source, {
          now: ctx.clock,
          desk: desk?.approvals === 'desk',
          timeZone: ctx.timeZone,
        });
  const mark = useMarkOut(api, passId ?? '', who?.name ?? '', setExited);
  const presence = presenceOf(o, ctx.timeZone);
  // A refused PIN brings the dialog back with the tries left.
  const note = desk?.note;
  useEffect(() => {
    if (note) setPin(true);
  }, [note]);
  const asking = pin && o.reason === 'needs_approval' && Boolean(desk);

  const run = useRunAct({
    machine,
    runtime,
    release: ctx.release,
    showPass: ctx.showPass,
    lookUp: ctx.lookUp,
    outcome: o,
    place,
    markOut: mark.markOut,
    ask: () => setPin(true),
    photo: photoInput,
    note: () => setNoteSignal((n) => n + 1),
  });
  const keys = ctx.keys;
  const wait = useQuietShortcut(ctx.type, ctx.quiet);
  useEffect(() => {
    const byKey = (key: Act['key']) =>
      [...(actions.primary ? [actions.primary] : []), ...actions.others].find(
        (a) => a.key === key && !a.lock,
      );
    keys.current = (command) => {
      if (command.c === 'primary') {
        const act = byKey('Enter');
        if (act) run(act);
        return Boolean(act);
      }
      const letter =
        command.c === 'out' ? 'O' : command.c === 'photo' ? 'P' : command.c === 'note' ? 'N' : null;
      const act = letter ? byKey(letter) : undefined;
      if (!act || !letter) return false;
      wait(letter.toLowerCase(), () => run(act));
      return true;
    };
    return () => {
      keys.current = null;
    };
  });
  const scan = source === 'scan';
  // Only a pass the machine knew has a history; the person's lines are read again after each new event.
  const person: PersonPanels | null =
    passId !== null && who
      ? {
          api,
          passId,
          zone: ctx.timeZone,
          now: ctx.clock,
          refresh: `${o.scanId ?? ''}:${o.kind}:${exited}:${noteTick}`,
          desk: rights.note,
          manager: rights.role === 'manager',
          noteSignal,
          onNoteAdded: () => setNoteTick((n) => n + 1),
        }
      : null;
  const held = band && o.kind !== 'ok' ? [band.title, band.sub].filter(Boolean).join(' · ') : null;
  return (
    <div className="op-rec-wrap">
      <RecordBuddy view={scan ? ctx.buddy : null} id={passId ?? o.scanId ?? ''} />
      <article
        className="op-rec"
        data-tone={band?.tone}
        data-kind={o.kind}
        data-source={source}
        data-testid={scan ? 'scan-result' : 'op-record'}
        aria-busy={false}
      >
        {band ? (
          <RecordBand
            band={band}
            where={scan && band.tone !== 'preview' ? (session.scanner?.name ?? null) : null}
            timeZone={ctx.timeZone}
            undo={scan ? ctx.undo : null}
            kind={o.kind}
            reason={o.reason}
          />
        ) : null}
        {who ? (
          <RecordIdentity
            who={who}
            presence={exited && presence ? { state: 'out', line: null } : presence}
            photo={
              addPhoto && !actions.viewOnly && passId ? (
                <PhotoSlot api={api} passId={passId} slot={photoInput} />
              ) : null
            }
          />
        ) : null}
        <RecordActions actions={actions} busy={mark.busy} onRun={run} />
        <RecordBody
          outcome={o}
          desk={desk}
          orgId={session.principal === 'admin' ? session.admin?.orgs[0]?.id : undefined}
          timeZone={ctx.timeZone}
          eventNote={session.event?.note}
          person={person}
        />
        {desk ? (
          <PinDialog
            open={asking}
            onOpenChange={setPin}
            desk={desk}
            name={who?.name ?? ''}
            held={held}
          />
        ) : null}
      </article>
    </div>
  );
}

/** A scan's answer or a desk card the machine is holding: the record, with the machine's actions. */
export function RecordScan({
  ctx,
  outcome,
  passId,
  desk,
}: {
  ctx: RecordContext;
  outcome: ScanOutcome;
  passId: string | null;
  desk: Desk;
}) {
  return <RecordView ctx={ctx} outcome={outcome} source="scan" passId={passId} desk={desk} />;
}

/** A person opened from a list or a search hit; a hit only previews, so nothing changes until an action. */
export function RecordPass({
  ctx,
  record,
}: {
  ctx: RecordContext;
  record: Extract<RecordRef, { kind: 'pass' }>;
}) {
  const { outcome, failed } = useResolved(ctx.api, record.passId, 0);
  // The heading exists once the pass has loaded; focus waiting on the pane goes there.
  const loaded = outcome !== null;
  useEffect(() => {
    if (loaded && document.activeElement?.hasAttribute('data-operator-record')) focusHeading();
  }, [loaded]);
  if (failed)
    return (
      <article className="op-rec" data-testid="op-record">
        <div className="op-rec-fail">
          <h2 data-operator-heading tabIndex={-1}>
            {R.unavailable}
          </h2>
          <Callout tone="danger">{R.failed}</Callout>
        </div>
      </article>
    );
  if (!outcome)
    return (
      <article className="op-rec" aria-busy data-testid="op-record">
        <p className="op-rec-wait" role="status">
          {R.opening}
        </p>
      </article>
    );
  return <RecordView ctx={ctx} outcome={outcome} source="open" passId={record.passId} />;
}
