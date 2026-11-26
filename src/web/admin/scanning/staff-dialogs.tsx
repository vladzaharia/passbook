import type { z } from 'zod';
import {
  ScanStaffSchema,
  StaffPinSchema,
  UpdateScanStaffSchema,
} from '@/shared/contracts/scanners.ts';
import { api } from '@/web/lib/api.ts';
import { ConfirmDialog, Dialog, DialogContent, SecretReveal } from '@/web/ui/index.ts';
import { issued } from './scanner-api.ts';

export type ScanStaff = z.infer<typeof ScanStaffSchema>;

export const staffPath = (id: string) => `/api/v1/scan-staff/${encodeURIComponent(id)}`;

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
          onReset(staff.name, issued(result.pin));
        } catch (cause) {
          onUncertain();
          throw cause;
        }
      }}
    />
  );
}

/** A PIN, shown once: copy it, say it is saved, then Done. */
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
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent title={`${name}'s PIN`}>
        <SecretReveal
          savedLabel="I saved the PIN"
          onDone={onClose}
          fields={[
            { label: 'PIN', value: pin, secret: false, copyLabel: 'Copy PIN', sheen: false },
          ]}
        />
      </DialogContent>
    </Dialog>
  );
}
