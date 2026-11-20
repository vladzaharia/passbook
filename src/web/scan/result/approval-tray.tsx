import { ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { SCAN_COPY, scanLine } from '../../../shared/copy/scan.ts';
import { SCAN_TRAY_COPY as COPY } from '../../../shared/copy/scan-tray.ts';
import { CODE_LENGTH } from '../../ui/code-field.tsx';
import type { PinNote } from '../machine/types.ts';
import { Keypad } from '../ui/keypad.tsx';
import { Tray } from '../ui/tray.tsx';
import { type Approver, ManagerList, ManagerRow, PinDots } from './approval-parts.tsx';
import { noteLine } from './approval-sheet.tsx';
import { usePinDraft } from './use-pin-draft.ts';
import './approval-tray.css';

/** A keyed PIN is dropped after this long with no key. */
const IDLE_MS = 30_000;

/** The last manager who approved, so the next PIN starts from them. Memory only; a reload forgets. */
let lastApprover: string | undefined;

export interface ApprovalTrayProps {
  /** What the PIN approves: "Redeem 1 Free coffee". */
  action?: string | undefined;
  managers: Approver[];
  /** Staff sign-in is off: six digits alone find the manager. */
  code: boolean;
  /** Desk staff may approve too. */
  desk: boolean;
  /** The last PIN was refused: the tries left, or locked. */
  note?: PinNote | undefined;
  /** The PIN is with the server. */
  busy: boolean;
  onApprove: (staffId: string | undefined, pin: string) => void;
  onCancel: () => void;
}

/**
 * A Manager's PIN at the door (design 6): who, six dots, a keypad. Six digits send themselves.
 * The digits are never in state, storage, the DOM or a log (`usePinDraft`); only the keys on the
 * screen enter them. The tray reads no keyboard: a reader's burst of digits and Enter is a scan,
 * for the wedge source to take, never six wrong PINs. A refusal clears
 * them and shows the tries left, a lockout shows how long, and nothing is retried here.
 */
export function ApprovalTray({
  action,
  managers,
  code,
  desk,
  note,
  busy,
  onApprove,
  onCancel,
}: ApprovalTrayProps) {
  const [staffId, setStaffId] = useState<string | undefined>(() =>
    managers.length === 1
      ? managers[0]?.id
      : managers.some((m) => m.id === lastApprover)
        ? lastApprover
        : undefined,
  );
  const [choosing, setChoosing] = useState(!code && managers.length > 1 && staffId === undefined);
  const [sent, setSent] = useState(false);
  const [shakes, setShakes] = useState(0);
  const [cleared, setCleared] = useState(false);
  const manager = managers.find((m) => m.id === staffId);
  const locked = note !== undefined && ('locked' in note || note.triesLeft === 0);
  const idle = busy || sent || locked || choosing || (!code && !manager);
  const pin = usePinDraft({
    length: CODE_LENGTH,
    idleMs: IDLE_MS,
    disabled: idle,
    onCleared: () => setCleared(true),
    onFull: (digits) => {
      setSent(true);
      if (managers.length > 1) lastApprover = staffId;
      onApprove(code ? undefined : staffId, digits);
    },
  });
  // A refused PIN is already gone: the dots shake and the keys are free again.
  useEffect(() => {
    if (!note) return;
    setSent(false);
    setShakes((n) => n + 1);
  }, [note]);
  const line = noteLine(note, code);
  const full = busy || sent;
  const status = full
    ? COPY.pin.checking
    : pin.count > 0
      ? scanLine(COPY.pin.count, { n: pin.count, len: CODE_LENGTH })
      : cleared
        ? COPY.pin.cleared
        : '';
  const title = code
    ? desk
      ? SCAN_COPY.managerCode.titleDesk
      : SCAN_COPY.managerCode.title
    : COPY.pin.title;
  const digit = (d: string) => {
    setCleared(false);
    pin.push(d);
  };
  return (
    <Tray label={title} onClose={onCancel} height={588} testId="scan-approval-tray">
      <fieldset className="scan-tray-body scan-pin" aria-label={title}>
        <div className="scan-pin-head">
          <span className="scan-pin-tile" aria-hidden>
            <ShieldCheck size={28} />
          </span>
          <div>
            <p className="scan-pin-title">{title}</p>
            <p className="scan-pin-sub">
              {scanLine(COPY.pin.approves, { action: action ?? 'this action' })}
            </p>
          </div>
        </div>
        {choosing ? (
          <ManagerList
            managers={managers}
            value={staffId}
            onPick={(id) => {
              setStaffId(id);
              setChoosing(false);
            }}
          />
        ) : (
          <>
            {!code && manager ? (
              <ManagerRow
                manager={manager}
                disabled={full}
                onChange={managers.length > 1 ? () => setChoosing(true) : undefined}
              />
            ) : null}
            <PinDots
              count={full ? CODE_LENGTH : pin.count}
              length={CODE_LENGTH}
              shake={shakes}
              invalid={line !== undefined}
            />
            <Keypad disabled={idle} onDigit={digit} onDelete={pin.pop} />
            <p className="scan-pin-note" role="alert" data-invalid={line ? '' : undefined}>
              {line ?? ''}
            </p>
          </>
        )}
        <p className="scan-sr" role="status" aria-live="polite">
          {status}
        </p>
      </fieldset>
      <button type="button" className="scan-tray-btn" disabled={busy} onClick={onCancel}>
        {SCAN_COPY.actions.cancel}
      </button>
    </Tray>
  );
}
