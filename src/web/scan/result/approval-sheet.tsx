import { useState } from 'react';
import { Button } from '../../ui/button.tsx';
import { CodeField } from '../../ui/code-field.tsx';
import { FormField } from '../../ui/field.tsx';
import { Select } from '../../ui/select.tsx';
import './picker.css';

/** A Manager's PIN for this one action: the managers on the roster, and their six digits. */
export function ApprovalSheet({
  managers,
  onApprove,
  onCancel,
}: {
  managers: { id: string; name: string }[];
  onApprove: (staffId: string | undefined, pin: string) => void;
  onCancel: () => void;
}) {
  // With a roster the manager is named; without one the PIN alone finds them.
  const [staffId, setStaffId] = useState('');
  const [pin, setPin] = useState('');
  return (
    <form
      className="scan-approval"
      data-testid="scan-approval"
      onSubmit={(event) => {
        event.preventDefault();
        if (pin.length === 6) onApprove(staffId || undefined, pin);
      }}
    >
      {managers.length > 1 ? (
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
      <FormField label="PIN">
        {(p) => <CodeField id={p.id} value={pin} onChange={setPin} />}
      </FormField>
      <div className="scan-picker-actions">
        <Button type="button" size="lg" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="lg" disabled={pin.length !== 6}>
          Approve
        </Button>
      </div>
    </form>
  );
}
