import { DoorOpen, ShieldCheck, Store } from 'lucide-react';
import { useId, useState } from 'react';
import type { ScanRole } from '@/shared/contracts/scan.ts';
import {
  CreateScanStaffSchema,
  ScanStaffSchema,
  StaffPinSchema,
  UpdateScanStaffSchema,
} from '@/shared/contracts/scanners.ts';
import { api } from '@/web/lib/api.ts';
import { isApiError } from '@/web/lib/errors.ts';
import {
  ConfirmDialog,
  FormDialog,
  FormField,
  Input,
  OptionTile,
  useFormErrors,
} from '@/web/ui/index.ts';
import { issued } from './scanner-api.ts';
import { type ScanStaff, staffPath } from './staff-dialogs.tsx';

const CreatedStaffSchema = StaffPinSchema.extend({ staff: ScanStaffSchema });

const ROLES = [
  { value: 'door', label: 'Door', description: 'Look up passes and check in.', icon: DoorOpen },
  { value: 'desk', label: 'Desk', description: 'Also add, take and use up.', icon: Store },
  {
    value: 'manager',
    label: 'Manager',
    description: 'Set values and override check-ins and undos.',
    icon: ShieldCheck,
  },
] as const;

/**
 * Add or edit one person. These writes deliberately bypass the mutation cache: create and reset
 * return one-time PINs. A write that may or may not have landed ends in a result that says to check
 * the list, never in a second try.
 */
export function StaffFormDialog({
  orgId,
  staff,
  onClose,
  onSaved,
  onCreated,
  onUncertain,
}: {
  orgId: string;
  staff?: ScanStaff;
  onClose: () => void;
  onSaved: () => void;
  onCreated: (name: string, pin: string) => void;
  onUncertain: () => void;
}) {
  const roleGroup = useId();
  const [name, setName] = useState(staff?.name ?? '');
  const [role, setRole] = useState<ScanRole>(staff?.role ?? 'door');
  const [uncertain, setUncertain] = useState('');
  const [confirmRole, setConfirmRole] = useState(false);
  const parsed = CreateScanStaffSchema.safeParse({ orgId, name, role });
  const check = useFormErrors({
    name: parsed.success ? undefined : 'Enter a name of up to 40 plain-text characters.',
  });
  const dirty = name !== (staff?.name ?? '') || role !== (staff?.role ?? 'door');

  async function save() {
    if (!parsed.success) return;
    try {
      if (staff) {
        const body = UpdateScanStaffSchema.parse({
          name: parsed.data.name,
          role: parsed.data.role,
        });
        await api.patch(staffPath(staff.id), ScanStaffSchema, body, { query: { orgId } });
        onSaved();
      } else {
        const created = await api.post('/api/v1/scan-staff', CreatedStaffSchema, parsed.data);
        onCreated(created.staff.name, issued(created.pin));
      }
    } catch (cause) {
      if (!isApiError(cause) || (cause.status !== 0 && cause.status < 500)) throw cause;
      setUncertain(
        staff
          ? 'Could not confirm whether changes were saved. Check the staff list before trying again.'
          : 'Could not confirm whether staff was added. Check the staff list before trying again; if the PIN is missing, reset it.',
      );
      onUncertain();
    }
  }

  function submit() {
    if (!staff) return save();
    if (!dirty) return onClose();
    if (role !== staff.role) return setConfirmRole(true);
    return save();
  }

  return (
    <>
      <FormDialog
        open
        onOpenChange={(open) => !open && onClose()}
        title={staff ? `Edit ${staff.name}` : 'Add staff'}
        description="Staff and their PINs are shared across live and test."
        dirty={dirty && !uncertain}
        check={check}
        onSubmit={submit}
        submitLabel={staff ? 'Save changes' : 'Add staff'}
        result={
          uncertain
            ? {
                title: 'Not confirmed',
                body: <p className="text-sm text-fg">{uncertain}</p>,
                onDone: onClose,
              }
            : undefined
        }
      >
        <FormField label="Name" required error={check.errors.name}>
          {(props) => (
            <Input
              {...props}
              data-autofocus
              value={name}
              maxLength={40}
              placeholder="Sam K."
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </FormField>
        <fieldset className="grid gap-2">
          <legend className="mb-2 text-sm font-medium text-fg-strong">Role</legend>
          {ROLES.map((option) => (
            <OptionTile
              key={option.value}
              name={roleGroup}
              value={option.value}
              label={option.label}
              description={option.description}
              icon={option.icon}
              checked={role === option.value}
              onSelect={() => setRole(option.value)}
            />
          ))}
        </fieldset>
      </FormDialog>
      {staff ? (
        <ConfirmDialog
          open={confirmRole}
          onOpenChange={setConfirmRole}
          title={`Change ${staff.name}'s role?`}
          description="Their scanner permissions change in both live and test."
          confirmLabel="Change role"
          onConfirm={save}
        />
      ) : null}
    </>
  );
}
