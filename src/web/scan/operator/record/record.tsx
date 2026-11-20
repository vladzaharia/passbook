import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScanSession } from '../../../../shared/contracts/scan-session.ts';
import { OPERATOR_COPY } from '../../../../shared/copy/scan-operator.ts';
import { Callout } from '../../../ui/callout.tsx';
import type { ScanApi } from '../../api/scan-api.ts';
import type { MachineEvent } from '../../machine/access-events.ts';
import type { Loop, ScanOutcome } from '../../machine/types.ts';
import type { ScanRuntime } from '../../platform/runtime.ts';
import type { Command } from '../keys.ts';
import type { RecordRef } from '../operator-model.ts';
import { type PinDesk, PinDialog } from './pin-dialog.tsx';
import { RecordActions } from './record-actions.tsx';
import { RecordBand } from './record-band.tsx';
import { type PickerDesk, RecordBody } from './record-body.tsx';
import { PhotoSlot, RecordIdentity } from './record-identity.tsx';
import {
  type Act,
  actionsOf,
  bandOf,
  displayOf,
  identityOf,
  markOutPlace,
  presenceOf,
  type Rights,
  rightsOf,
  type Source,
} from './record-model.ts';
import { useMarkOut } from './use-mark-out.ts';
import { useResolved } from './use-resolved.ts';
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
  const mayAct = passId !== null;
  const addPhoto = rights.photo && noPhoto && mayAct;
  const actions = actionsOf(o, {
    source,
    rights,
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

  const run = useCallback(
    (act: Act) => {
      const r = act.run;
      switch (r.t) {
        case 'pick':
          return machine({ type: 'pick', actionId: r.actionId });
        case 'group':
          return machine({ type: 'group' });
        case 'override':
          return machine({ type: 'override', actionId: r.actionId });
        case 'turn':
          return machine({ type: 'turn', direction: r.direction });
        case 'ask':
          return setPin(true);
        case 'photo':
          return photoInput.current?.click();
        case 'mark-out':
          return place ? void mark.markOut(place) : undefined;
        case 'check-in':
          if (o.card) {
            ctx.release();
            runtime.checkIn(o.card, r.actionId);
          }
          return;
        case 'open':
          ctx.release();
          return runtime.emit({ method: 'manual', passId: r.passId });
      }
    },
    [machine, runtime, ctx, o.card, place, mark],
  );
  const keys = ctx.keys;
  useEffect(() => {
    const byKey = (key: Act['key']) =>
      [...(actions.primary ? [actions.primary] : []), ...actions.others].find(
        (a) => a.key === key && !a.lock,
      );
    keys.current = (command) => {
      const act =
        command.c === 'primary'
          ? byKey('Enter')
          : command.c === 'out'
            ? byKey('O')
            : command.c === 'photo'
              ? byKey('P')
              : undefined;
      if (!act) return false;
      run(act);
      return true;
    };
    return () => {
      keys.current = null;
    };
  });
  const scan = source === 'scan';
  const held = band && o.kind !== 'ok' ? [band.title, band.sub].filter(Boolean).join(' · ') : null;
  return (
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
      />
      {desk ? (
        <PinDialog
          open={asking}
          onOpenChange={setPin}
          desk={desk}
          name={who?.name ?? ''}
          held={held}
          action={o.action?.label}
        />
      ) : null}
    </article>
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
  const preview = record.from === 'search';
  const { outcome, failed } = useResolved(ctx.api, record.passId, preview ? 140 : 0);
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
  return (
    <RecordView
      ctx={ctx}
      outcome={outcome}
      source={preview ? 'search' : 'open'}
      passId={record.passId}
    />
  );
}
