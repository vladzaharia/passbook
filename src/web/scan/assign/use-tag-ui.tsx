import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import { SCAN_TAG_COPY } from '../../../shared/copy/scan-tags.ts';
import { formatTime } from '../../lib/format.ts';
import type { ScanApi } from '../api/scan-api.ts';
import { AssignChip } from '../enroll/request-chip.tsx';
import { RequestStrip } from '../enroll/request-strip.tsx';
import { useEnrollment } from '../enroll/use-enroll.ts';
import type { MachineEvent } from '../machine/access-events.ts';
import type { CardRef } from '../machine/assign-state.ts';
import { assignOf, requestOf, stripOfAssign } from '../machine/assign-view.ts';
import { cardOf } from '../machine/reduce-assign.ts';
import type { ScanInput, ScanOutcome, ScanState } from '../machine/types.ts';
import type { ScanRuntime } from '../platform/runtime.ts';
import { useNativeCapabilities } from '../platform/use-native-capabilities.ts';
import type { StripEntry } from '../ui/last-scan-strip.tsx';
import { AssignCard, type AssignCardContext, toneOf } from './assign-card.tsx';
import { AssignDock } from './assign-dock.tsx';
import { TAG_EXTRA_COPY } from './copy.ts';
import { canTapToRead, type TagReader, tagReaderOf } from './tag-reader.ts';
import { tagsPortOf } from './tags-port.ts';

type Role = 'door' | 'desk' | 'manager';

export interface TagUi {
  active: boolean;
  /** The camera dims behind the card, except while the pass is asked for. */
  dim: boolean;
  chip: ReactNode;
  card: ReactNode | null;
  dock: ReactNode | null;
  tint: 'green' | 'amber' | 'red' | 'slate' | null;
  pose: 'pair' | 'aim' | null;
  strip: StripEntry | null;
  onUndo: (() => void) | null;
  layer: ReactNode;
  /** The menu item: absent when this scanner cannot assign. */
  menu: { offline: boolean; onSelect: () => void } | null;
  /** Door on an iPhone: the button that opens the system reader. */
  tapToRead: (() => void) | null;
  /** On a result card: Add tag, and Assign tag for an unknown one. */
  addTag: (() => void) | null;
  assignUnknown: (() => void) | null;
  reader: TagReader;
}

const TINT = {
  ok: 'green',
  heads_up: 'amber',
  refused: 'red',
  system: 'slate',
  ready: null,
} as const;

/** The scanner's role: the signed-in person's, or the one it runs as with nobody signed in. */
const roleOf = (session: ScanSession): Role =>
  session.staff?.role ?? session.scanner?.settings.roleWithoutSignIn ?? 'door';

/**
 * Everything tags add to the scanner loop: the Assign tag card and its dock, the capsule chip, an
 * admin's request (chip, strip, socket), Add tag on a result, and Tap to read at an iPhone door.
 * `ScanLoop` places the pieces; the machine owns the state.
 */
export function useTagUi({
  runtime,
  session,
  api,
  state: s,
  result,
  open: openLookup,
  dispatch,
}: {
  runtime: ScanRuntime;
  session: ScanSession;
  api: ScanApi;
  state: ScanState;
  /** The result on screen, if any, and the scan that made it. */
  result: ScanOutcome | null;
  /** Opens or closes the Look up sheet. */
  open: (sheet: boolean) => void;
  dispatch: (event: MachineEvent) => void;
}): TagUi {
  const native = useNativeCapabilities();
  const announce = runtime.announce;
  const outcome =
    result && 'input' in s.loop ? { outcome: result, input: s.loop.input as ScanInput } : null;
  const scanner = session.scanner;
  const [web, setWeb] = useState(runtime.webNfc.status());
  const [readerNote, setReaderNote] = useState<AssignCardContext['readerNote']>(null);
  const reader = useMemo(
    () => tagReaderOf(native, { supported: runtime.webNfc.supported, status: web }, s.reader.kind),
    [native, runtime, web, s.reader.kind],
  );
  const role = roleOf(session);
  const setting = scanner?.settings.tags?.assign ?? 'desk';
  const device = scanner?.deviceRole === 'scan' && session.principal !== 'admin';
  const canAssign =
    device &&
    reader.kind !== 'none' &&
    role !== 'door' &&
    (setting === 'desk' || (setting === 'manager' && role === 'manager'));
  const a = assignOf(s);
  const waiting = requestOf(s);

  useEffect(
    () => runtime.onTagEnded((why) => setReaderNote(why === 'cancelled' ? 'cancelled' : 'no_read')),
    [runtime],
  );
  useEffect(() => {
    if (a?.tag) setReaderNote(null);
  }, [a?.tag]);

  const tags = useMemo(() => tagsPortOf(api), [api]);
  useEnrollment({
    api: tags,
    enabled: device && reader.kind !== 'none' && s.started && s.block === null,
    showing: a?.request?.id ?? null,
    dispatch,
  });

  // The request's last 30 seconds are announced once, the end by the machine.
  const requestEnds = a?.request?.expiresAt;
  useEffect(() => {
    if (!requestEnds) return;
    const wait = requestEnds - 30_000 - Date.now();
    if (wait < 0) return;
    const t = setTimeout(() => announce(TAG_EXTRA_COPY.secondsLeft, true), wait);
    return () => clearTimeout(t);
  }, [requestEnds, announce]);

  // iPhone: the system sheet is the reader. A request or Assign tag at step 1 opens it for the person.
  const tapRead = useCallback(() => {
    setReaderNote(null);
    runtime.readTag();
  }, [runtime]);
  const startNfc = useCallback(() => {
    void runtime.webNfc.arm().then(setWeb);
  }, [runtime]);

  const managers = (session.staffList ?? []).filter((m) => m.role === 'manager');
  const ctx: AssignCardContext = {
    org: scanner?.orgName ?? '',
    reader,
    manager: role === 'manager',
    managers,
    code: session.staffList === null,
    knownName: outcome?.outcome.display?.identity.holder ?? null,
    readerNote,
    webStatus: web,
  };
  const strip = stripOfAssign(s);
  const stripEntry: StripEntry | null = strip
    ? {
        kind: strip.kind === 'assigned' ? 'ok' : 'system',
        title:
          strip.kind === 'assigned'
            ? (SCAN_TAG_COPY.strip.assigned.split(' · ')[0] ?? 'Tag assigned')
            : strip.kind === 'undone'
              ? TAG_EXTRA_COPY.stripUndone
              : SCAN_TAG_COPY.strip[strip.kind],
        meta: strip.kind === 'assigned' ? `${strip.name ?? ''} · ${formatTime(strip.at)}` : '',
        undoable:
          strip.kind === 'assigned' &&
          Boolean(strip.bindingId) &&
          (strip.undoUntil ?? 0) > Date.now(),
      }
    : null;

  const open = (card: CardRef | null) =>
    dispatch(
      card ? { type: 'assign.open', from: 'card', card } : { type: 'assign.open', from: 'menu' },
    );
  const input = outcome?.input;
  const known: CardRef | null =
    input && !input.tag && (input.code !== undefined || input.passId !== undefined)
      ? cardOf(input)
      : null;
  const isDeskResult =
    canAssign &&
    outcome !== null &&
    (outcome.outcome.kind === 'ok' || outcome.outcome.kind === 'ready') &&
    !outcome.outcome.local;

  const chip = a ? (
    <AssignChip
      mode={a.request ? 'request-open' : 'assigning'}
      {...(a.request ? { holderName: a.request.holderName, expiresAt: a.request.expiresAt } : {})}
      onPress={() => dispatch({ type: 'assign.cancel' })}
    />
  ) : waiting && !waiting.opened ? (
    <AssignChip mode="request-waiting" onPress={() => dispatch({ type: 'enroll.open' })} />
  ) : null;

  const busyLoop = s.loop.s === 'member' || s.loop.s === 'reviewing';
  const layer =
    waiting && !waiting.opened && !a && busyLoop && !waiting.later ? (
      <RequestStrip
        name={waiting.request.holderName}
        onOpen={() => dispatch({ type: 'enroll.open' })}
        onLater={() => dispatch({ type: 'enroll.later' })}
      />
    ) : null;

  const tone = a ? toneOf(a) : null;
  return {
    active: a !== null,
    dim: a !== null && a.step !== 'pass',
    chip,
    card: a ? (
      <AssignCard
        key={a.source}
        a={a}
        ctx={ctx}
        on={{
          scope: (scope) => dispatch({ type: 'assign.scope', scope }),
          label: (label) => dispatch({ type: 'assign.label', label }),
          approve: (staffId, pin) =>
            dispatch({ type: 'assign.approve', ...(staffId ? { staffId } : {}), pin }),
          closePin: () => dispatch({ type: 'assign.pin', open: false }),
        }}
      />
    ) : null,
    dock: a ? (
      <AssignDock
        a={a}
        reader={reader}
        manager={role === 'manager'}
        webStatus={web}
        on={{
          cancel: () => dispatch({ type: 'assign.cancel' }),
          back: () => dispatch({ type: 'assign.back' }),
          done: () => dispatch({ type: 'assign.done' }),
          again: (keepPass) => dispatch({ type: 'assign.again', keepPass }),
          bind: (move) => dispatch({ type: 'assign.bind', ...(move ? { move: true } : {}) }),
          askManager: () => dispatch({ type: 'assign.pin', open: true, move: true }),
          retry: () => dispatch({ type: 'assign.retry' }),
          readTag: tapRead,
          startNfc,
          lookUp: () => openLookup(true),
        }}
      />
    ) : null,
    tint: tone ? TINT[tone] : null,
    pose: a ? (a.step === 'pass' ? 'aim' : 'pair') : null,
    strip: stripEntry,
    onUndo: strip?.bindingId ? () => dispatch({ type: 'assign.undo' }) : null,
    layer,
    menu: canAssign ? { offline: !s.online, onSelect: () => open(null) } : null,
    tapToRead: reader.kind === 'sheet' && device && canTapToRead(reader) && !a ? tapRead : null,
    addTag: isDeskResult && known ? () => open(known) : null,
    assignUnknown:
      canAssign && outcome && input?.tag && outcome.outcome.reason === 'not_found'
        ? () =>
            dispatch({
              type: 'assign.open',
              from: 'unknown_tag',
              tag: input.tag as NonNullable<typeof input.tag>,
              sig: input.sig,
            })
        : null,
    reader,
  };
}
