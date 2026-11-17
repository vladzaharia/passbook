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
  onApprove: (staffId: string, pin: string) => void;
  onCancel: () => void;
}) {
  const [staffId, setStaffId] = useState(managers.length === 1 ? (managers[0]?.id ?? '') : '');
  const [pin, setPin] = useState('');
  return (
    <form
      className="scan-approval"
      data-testid="scan-approval"
      onSubmit={(event) => {
        event.preventDefault();
        if (staffId && pin.length === 6) onApprove(staffId, pin);
      }}
    >
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
      <FormField label="PIN">
        {(p) => <CodeField id={p.id} value={pin} onChange={setPin} />}
      </FormField>
      <div className="scan-picker-actions">
        <Button type="button" size="lg" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="lg" disabled={!staffId || pin.length !== 6}>
          Approve
        </Button>
      </div>
    </form>
  );
}
