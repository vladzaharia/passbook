import { useEffect, useState } from 'react';
import { SCAN_COPY, scanLine } from '../../../shared/copy/scan.ts';
import { Button } from '../../ui/button.tsx';
import { CodeField } from '../../ui/code-field.tsx';
import { FormField } from '../../ui/field.tsx';
import { Select } from '../../ui/select.tsx';
import type { PinNote } from '../machine/types.ts';
import './picker.css';

const noteLine = (note: PinNote | undefined, code: boolean) => {
  if (!note) return undefined;
  const copy = code ? SCAN_COPY.managerCode : null;
  if ('locked' in note) return copy ? copy.locked : SCAN_COPY.boot.pinLocked;
  const wrong = copy ? copy.wrong : SCAN_COPY.boot.wrongPin;
  return note.triesLeft > 0 ? scanLine(wrong, { n: note.triesLeft }) : SCAN_COPY.boot.pinLocked;
};

/**
 * A Manager's PIN for this one action. With staff sign-in on the manager is named; with it off
 * (`code`) the six digits alone find them: a manager code.
 */
export function ApprovalSheet({
  managers,
  code = false,
  action,
  note,
  onApprove,
  onCancel,
}: {
  managers: { id: string; name: string }[];
  code?: boolean;
  action?: string;
  note?: PinNote | undefined;
  onApprove: (staffId: string | undefined, pin: string) => void;
  onCancel: () => void;
}) {
  const [staffId, setStaffId] = useState(managers.length === 1 ? (managers[0]?.id ?? '') : '');
  const [pin, setPin] = useState('');
  const locked = note !== undefined && ('locked' in note || note.triesLeft === 0);
  // A refused PIN is cleared so the next six digits are a fresh try.
  useEffect(() => {
    if (note) setPin('');
  }, [note]);
  const error = noteLine(note, code);
  const named = !code && managers.length > 1;
  return (
    <form
      className="scan-approval"
      data-testid="scan-approval"
      onSubmit={(event) => {
        event.preventDefault();
        if (pin.length === 6 && !locked) onApprove(code ? undefined : staffId || undefined, pin);
      }}
    >
      {code ? (
        <>
          <h2 className="scan-picker-title">{SCAN_COPY.managerCode.title}</h2>
          <p className="scan-approval-verb">
            {scanLine(SCAN_COPY.managerCode.verb, { action: action ?? 'This action' })}
          </p>
        </>
      ) : null}
      {named ? (
        <FormField label="Manager">
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
            describedBy={p['aria-describedby']}
          />
        )}
      </FormField>
      <div className="scan-picker-actions">
        <Button type="button" size="lg" variant="outline" onClick={onCancel}>
          {SCAN_COPY.actions.cancel}
        </Button>
        <Button type="submit" size="lg" disabled={pin.length !== 6 || locked}>
          {code ? SCAN_COPY.managerCode.continue : 'Approve'}
        </Button>
      </div>
    </form>
  );
}
