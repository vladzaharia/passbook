import { zoneOptions } from '@/web/lib/timezones.ts';
import { FormField, Input, Select, SwitchRow } from '@/web/ui/index.ts';
import { CheckInFields } from '../check-in-fields.tsx';
import { AdmitsPicker } from './admits-picker.tsx';
import { AdmitsRules } from './admits-rules.tsx';
import type { SessionDraft as ScannerDraft } from './draft.ts';
import { SessionAccessFields } from './session-access-fields.tsx';
import { SessionCustomerFields } from './session-customer-fields.tsx';
import { SessionHoursFields } from './session-hours-fields.tsx';
import { SessionOfflineFields } from './session-offline-fields.tsx';
import type { SessionBodyId } from './session-steps.ts';

function SessionScope({
  draft,
  set,
  errors,
}: {
  draft: ScannerDraft;
  set: (patch: Partial<ScannerDraft>) => void;
  errors: Errors;
}) {
  return (
    <div className="grid gap-4">
      <FormField label="Session name" required error={errors.name}>
        {(p) => (
          <Input
            {...p}
            data-autofocus
            value={draft.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="Membership entrance"
            maxLength={80}
          />
        )}
      </FormField>
      <FormField label="Time zone">
        {(p) => (
          <Select
            {...p}
            value={draft.timeZone}
            options={zoneOptions()}
            onValueChange={(timeZone) => set({ timeZone })}
          />
        )}
      </FormField>
      <SessionHoursFields draft={draft} set={set} />
      <AdmitsPicker
        orgId={draft.orgId}
        any={draft.accepts === 'all'}
        templateIds={draft.templateIds}
        eventIds={draft.eventIds}
        onAnyChange={(any) => set({ accepts: any ? 'all' : 'templates' })}
        onChange={set}
      />
      {errors.accepts ? <p className="-mt-2 text-xs text-danger">{errors.accepts}</p> : null}
      {draft.accepts === 'all' ? null : (
        <AdmitsRules orgId={draft.orgId} templateIds={draft.templateIds} cap={draft.checkIn} />
      )}
    </div>
  );
}
function SessionDefaults({
  draft,
  set,
}: {
  draft: ScannerDraft;
  set: (patch: Partial<ScannerDraft>) => void;
}) {
  return (
    <div className="grid gap-4">
      <FormField
        label="On scan, tap or entered code"
        help="Name and email lookups always require confirmation."
      >
        {(p) => (
          <Select
            {...p}
            value={draft.flow}
            onValueChange={(v) => set({ flow: v as ScannerDraft['flow'] })}
            options={[
              { value: 'auto', label: 'Check in automatically' },
              { value: 'choose', label: 'Review before check-in' },
            ]}
          />
        )}
      </FormField>
      <FormField label="Default reader">
        {(p) => (
          <Select
            {...p}
            value={draft.reader}
            onValueChange={(v) => set({ reader: v as ScannerDraft['reader'] })}
            options={[
              { value: 'none', label: 'Camera' },
              { value: 'barcode', label: 'Hardware / keyboard scanner' },
            ]}
          />
        )}
      </FormField>
      <SwitchRow
        label="Look up people"
        checked={draft.lookup}
        onCheckedChange={(lookup) => set({ lookup })}
      />
      <SwitchRow
        label="Show member photos"
        checked={draft.showPhoto}
        onCheckedChange={(showPhoto) => set({ showPhoto })}
      />
    </div>
  );
}

function SessionStaff({
  draft,
  set,
}: {
  draft: ScannerDraft;
  set: (patch: Partial<ScannerDraft>) => void;
}) {
  return (
    <section className="mt-6 grid gap-4 border-t border-border pt-6">
      <div>
        <h3 className="text-sm font-semibold text-fg-strong">Staff access</h3>
        <p className="mt-1 text-xs text-fg-muted">
          Admin-as-scanner sessions use the signed-in administrator’s Manager permissions.
        </p>
      </div>
      <SwitchRow
        label="Require staff sign-in"
        help="Paired scanners only. Tills have no staff PINs and use the access level below. With several managers, turn it on so a PIN is checked against the manager chosen."
        checked={draft.staffSignIn}
        onCheckedChange={(staffSignIn) => set({ staffSignIn })}
      />
      <FormField label="Staff access without sign-in">
        {(p) => (
          <Select
            {...p}
            value={draft.roleWithoutSignIn}
            onValueChange={(v) =>
              set({ roleWithoutSignIn: v as ScannerDraft['roleWithoutSignIn'] })
            }
            options={[
              { value: 'door', label: 'Check-in staff' },
              { value: 'desk', label: 'Desk staff' },
            ]}
          />
        )}
      </FormField>
      <FormField label="Who can admit again">
        {(p) => (
          <Select
            {...p}
            value={draft.letInAgain}
            onValueChange={(v) => set({ letInAgain: v as ScannerDraft['letInAgain'] })}
            options={[
              { value: 'anyone', label: 'Anyone' },
              { value: 'manager', label: 'Managers' },
              { value: 'never', label: 'No one' },
            ]}
          />
        )}
      </FormField>
      <SwitchRow
        label="Hard limit"
        help="Full is final at this door, for everyone. Set it on a zone or an event to cover every door."
        checked={draft.hardLimit}
        onCheckedChange={(hardLimit) => set({ hardLimit })}
      />
      <FormField
        label="Approvals"
        help="Whose PIN approves a risky action. Setting a value, an amount over its max, undo and hard refusals always need a Manager."
      >
        {(p) => (
          <Select
            {...p}
            value={draft.approvals}
            onValueChange={(v) => set({ approvals: v as ScannerDraft['approvals'] })}
            options={[
              { value: 'managers', label: 'Managers' },
              { value: 'desk', label: 'Desk staff too' },
            ]}
          />
        )}
      </FormField>
    </section>
  );
}
export type Errors = Record<string, string | undefined>;

/** One step's body: the same for New session, Duplicate and Session rules. */
export function SessionFields({
  draft,
  set,
  step,
  errors = {},
}: {
  draft: ScannerDraft;
  set: (patch: Partial<ScannerDraft>) => void;
  step: SessionBodyId;
  errors?: Errors;
}) {
  if (step === 'passes') return <SessionScope draft={draft} set={set} errors={errors} />;
  if (step === 'rules')
    return (
      <>
        <CheckInFields
          orgId={draft.orgId}
          timeZone={draft.timeZone}
          rules={draft.checkIn}
          onChange={(checkIn) => set({ checkIn })}
        />
        <SessionOfflineFields draft={draft} set={set} />
        <SessionStaff draft={draft} set={set} />
      </>
    );
  if (step === 'access') return <SessionAccessFields draft={draft} set={set} />;
  if (step === 'customer')
    return (
      <SessionCustomerFields
        desk={draft.deskActions}
        value={draft.customer}
        onChange={(customer) => set({ customer })}
      />
    );
  return <SessionDefaults draft={draft} set={set} />;
}
