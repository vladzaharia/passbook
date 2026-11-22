import { useEffect, useState } from 'react';
import { SCAN_COPY, scanLine } from '../../../shared/copy/scan.ts';
import { SCAN_TRAY_COPY } from '../../../shared/copy/scan-tray.ts';
import { Button } from '../../ui/button.tsx';
import { CodeField } from '../../ui/code-field.tsx';
import { FormField } from '../../ui/field.tsx';
import { Select } from '../../ui/select.tsx';
import { type PinNote, pinSpent } from '../machine/fail.ts';
import './picker.css';

/** "3 min" (rounded up, at least 1), or "1 hour" from 60. */
export function waitLine(ms: number): string {
  const n = Math.max(1, Math.ceil(ms / 60_000));
  return n >= 60 ? '1 hour' : `${n} min`;
}

export const noteLine = (note: PinNote | undefined, code: boolean) => {
  if (!note) return undefined;
  if ('unreachable' in note) return SCAN_TRAY_COPY.pin.unreachable;
  const copy = code ? SCAN_COPY.managerCode : null;
  const locked = copy ? copy.locked : SCAN_COPY.boot.pinLocked;
  // No Retry-After yet (the last try was just used): the person window is 5 min.
  if ('locked' in note) return scanLine(locked, { wait: waitLine(note.retryAfterMs ?? 300_000) });
  const wrong = copy ? copy.wrong : SCAN_COPY.boot.wrongPin;
  return note.triesLeft > 0
    ? scanLine(wrong, { n: note.triesLeft })
    : scanLine(locked, { wait: waitLine(300_000) });
};

/**
 * A Manager's PIN for this one action. With staff sign-in on the manager is named; with it off
 * (`code`) the six digits alone find them: a manager code.
 */
export function ApprovalSheet({
  managers,
  code = false,
  desk = false,
  action,
  note,
  onApprove,
  onCancel,
}: {
  managers: { id: string; name: string }[];
  code?: boolean;
  /** Desk staff may approve too. */
  desk?: boolean;
  action?: string;
  note?: PinNote | undefined;
  onApprove: (staffId: string | undefined, pin: string) => void;
  onCancel: () => void;
}) {
  // Nothing is chosen for the person while more than one may approve.
  const [staffId, setStaffId] = useState(managers.length === 1 ? (managers[0]?.id ?? '') : '');
  const [pin, setPin] = useState('');
  const locked = pinSpent(note);
  // A refused PIN is cleared so the next six digits are a fresh try.
  useEffect(() => {
    if (note) setPin('');
  }, [note]);
  const error = noteLine(note, code);
  const named = !code && managers.length > 1;
  // With names on, the PIN is only ever checked against the person chosen.
  const ready = pin.length === 6 && !locked && (code || staffId !== '');
  return (
    <form
      className="scan-approval"
      data-testid="scan-approval"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) onApprove(code ? undefined : staffId, pin);
      }}
    >
      {code ? (
        <h2 className="scan-picker-title">
          {desk ? SCAN_COPY.managerCode.titleDesk : SCAN_COPY.managerCode.title}
        </h2>
      ) : null}
      {action ? (
        <p className="scan-approval-verb">
          {scanLine(desk ? SCAN_COPY.managerCode.verbDesk : SCAN_COPY.managerCode.verb, { action })}
        </p>
      ) : null}
      {named ? (
        <FormField label={desk ? SCAN_COPY.managerCode.approver : 'Manager'}>
          {(p) => (
            <Select
              {...p}
              value={staffId || undefined}
              onValueChange={setStaffId}
              options={managers.map((m) => ({ value: m.id, label: m.name }))}
            />
          )}
        </FormField>
      ) : null}
      <FormField label={code ? SCAN_COPY.managerCode.field : 'PIN'} error={error}>
        {(p) => (
          <CodeField
            id={p.id}
            value={pin}
            onChange={setPin}
            disabled={locked}
            invalid={error !== undefined}
            autoComplete="off"
            describedBy={p['aria-describedby']}
          />
        )}
      </FormField>
      <div className="scan-picker-actions">
        <Button type="button" size="lg" variant="outline" onClick={onCancel}>
          {SCAN_COPY.actions.cancel}
        </Button>
        <Button type="submit" size="lg" disabled={!ready}>
          {code ? SCAN_COPY.managerCode.continue : 'Approve'}
        </Button>
      </div>
    </form>
  );
}
