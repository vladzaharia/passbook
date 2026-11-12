import { DoorOpen, ShieldCheck, Store } from 'lucide-react';
import { useId, useState } from 'react';
import type { z } from 'zod';
import type { ScanRole } from '@/shared/contracts/scan.ts';
import {
  CreateScanStaffSchema,
  ScanStaffSchema,
  StaffPinSchema,
  UpdateScanStaffSchema,
} from '@/shared/contracts/scanners.ts';
import { api } from '@/web/lib/api.ts';
import { errorMessage, isApiError } from '@/web/lib/errors.ts';
import {
  Button,
  Callout,
  ConfirmDialog,
  Dialog,
  DialogContent,
  Form,
  FormField,
  Input,
  OptionTile,
  SecretReveal,
  useFormErrors,
} from '@/web/ui/index.ts';

export type ScanStaff = z.infer<typeof ScanStaffSchema>;

const CreatedStaffSchema = StaffPinSchema.extend({ staff: ScanStaffSchema });
const staffPath = (id: string) => `/api/v1/scan-staff/${encodeURIComponent(id)}`;

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

/** These writes deliberately bypass the mutation cache: create and reset return one-time PINs. */
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
  const formId = useId();
  const roleGroup = useId();
  const [name, setName] = useState(staff?.name ?? '');
  const [role, setRole] = useState<ScanRole>(staff?.role ?? 'door');
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState('');
  const [confirmRole, setConfirmRole] = useState(false);
  const check = useFormErrors({
    name: CreateScanStaffSchema.safeParse({ orgId, name, role }).success
      ? undefined
      : 'Enter a name of up to 40 plain-text characters.',
  });
  const dirty = name !== (staff?.name ?? '') || role !== (staff?.role ?? 'door');

  async function save() {
    const parsed = CreateScanStaffSchema.safeParse({ orgId, name, role });
    if (!parsed.success) return;
    setError('');
    setBusy(true);
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
        onCreated(created.staff.name, created.pin);
      }
    } catch (cause) {
      if (isApiError(cause) && (cause.status === 0 || cause.status >= 500)) {
        setUncertain(true);
        setError(
          staff
            ? 'Could not confirm whether changes were saved. Check the staff list before trying again.'
            : 'Could not confirm whether staff was added. Check the staff list before trying again; if the PIN is missing, reset it.',
        );
        onUncertain();
      } else {
        setError(errorMessage(cause));
      }
    } finally {
      setBusy(false);
    }
  }

  function submit() {
    if (uncertain || busy) return;
    if (staff && role !== staff.role) setConfirmRole(true);
    else void save();
  }

  return (
    <>
      <Dialog
        open
        dirty={dirty && !busy && !uncertain}
        onOpenChange={(open) => !open && !busy && onClose()}
      >
        <DialogContent
          title={staff ? `Edit ${staff.name}` : 'Add staff'}
          description="Staff and their PINs are shared across live and test."
          closeButton={!busy}
          footer={
            <>
              <Button variant="outline" disabled={busy} onClick={onClose}>
                {uncertain ? 'Close' : 'Cancel'}
              </Button>
              <Button
                type="submit"
                form={formId}
                loading={busy}
                disabled={!name.trim() || uncertain}
              >
                {staff ? 'Save changes' : 'Add staff'}
              </Button>
            </>
          }
        >
          <Form {...check.form} id={formId} className="grid gap-4" onValid={submit}>
            {error ? <Callout tone="danger">{error}</Callout> : null}
            <FormField
              label="Name"
              required
              help="Shown to other staff on the scanner."
              error={check.errors.name}
            >
              {(props) => (
                <Input
                  {...props}
                  value={name}
                  maxLength={40}
                  placeholder="Sam K."
                  disabled={busy || uncertain}
                  onChange={(event) => {
                    setName(event.target.value);
                  }}
                />
              )}
            </FormField>
            <fieldset className="grid gap-2" disabled={busy || uncertain}>
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
                  disabled={busy || uncertain}
                />
              ))}
            </fieldset>
          </Form>
        </DialogContent>
      </Dialog>
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

export function StaffStatusDialog({
  orgId,
  staff,
  onClose,
  onSaved,
}: {
  orgId: string;
  staff: ScanStaff;
  onClose: () => void;
  onSaved: () => void;
}) {
  const enable = staff.disabledAt !== null;
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`${enable ? 'Enable' : 'Disable'} ${staff.name}?`}
      description={
        enable
          ? 'They can sign in again with their existing PIN in both live and test.'
          : 'They will be signed out of all scanners and cannot sign in. Their scans remain. This applies in both live and test.'
      }
      confirmLabel={enable ? 'Enable' : 'Disable'}
      destructive={!enable}
      onConfirm={async () => {
        const body = UpdateScanStaffSchema.parse({ disabled: !enable });
        try {
          await api.patch(staffPath(staff.id), ScanStaffSchema, body, { query: { orgId } });
        } finally {
          onSaved();
        }
      }}
    />
  );
}

export function StaffResetDialog({
  orgId,
  staff,
  onClose,
  onReset,
  onUncertain,
}: {
  orgId: string;
  staff: ScanStaff;
  onClose: () => void;
  onReset: (name: string, pin: string) => void;
  onUncertain: () => void;
}) {
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Reset ${staff.name}'s PIN?`}
      description={`${staff.disabledAt !== null ? 'They will remain disabled until you enable them. ' : ''}Their old PIN stops working and they will be signed out of all scanners in both live and test. Temporary PIN locks remain until they expire. Share the new PIN securely; it is shown only once. If the request is interrupted, reset again to get a new PIN.`}
      confirmLabel="Reset PIN"
      onConfirm={async () => {
        try {
          const result = await api.post(
            `${staffPath(staff.id)}/reset-pin`,
            StaffPinSchema,
            undefined,
            { query: { orgId } },
          );
          onReset(staff.name, result.pin);
        } catch (cause) {
          onUncertain();
          throw cause;
        }
      }}
    />
  );
}

export function StaffPinDialog({
  name,
  pin,
  onClose,
}: {
  name: string;
  pin: string;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={() => undefined}>
      <DialogContent
        title={`${name}'s PIN`}
        description="Share this PIN securely with the staff member."
        closeButton={false}
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => event.preventDefault()}
      >
        <SecretReveal
          fields={[{ label: 'PIN', value: pin, copyLabel: 'Copy PIN' }]}
          savedLabel="I saved the PIN"
          onDone={onClose}
        />
      </DialogContent>
    </Dialog>
  );
}
