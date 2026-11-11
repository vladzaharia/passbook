import type { Mode } from '@/shared/contracts/common.ts';
import { useMode } from '@/web/lib/mode.ts';
import {
  CheckboxField,
  FormField,
  Input,
  NumberField,
  SegmentedControl,
  Select,
  SwitchRow,
} from '@/web/ui/index.ts';
import { CheckInFields } from '../check-in-fields.tsx';
import { EligibleTemplatePicker } from '../eligible-template-picker.tsx';
import { useScanEvents } from '../scanner-api.ts';
import type { ScannerDraft } from './scanner-draft.ts';
import { SetupFields, type SetupFieldsProps } from './setup-fields.tsx';

export interface ScannerFieldsProps extends SetupFieldsProps {
  mode: Mode;
}

const FLOW = [
  { value: 'auto', label: 'Check in automatically' },
  { value: 'choose', label: 'Review before check-in' },
];
const ROLE = [
  { value: 'door', label: 'Door' },
  { value: 'desk', label: 'Desk' },
];
const AGAIN = [
  { value: 'anyone', label: 'Anyone' },
  { value: 'manager', label: 'Managers' },
  { value: 'never', label: 'Never' },
];
const READER = [
  { value: 'none', label: 'None' },
  { value: 'barcode', label: 'Barcode reader' },
];

/** The legacy scanner settings form, shown on existing standalone scanner records. */
export function ScannerFields({ draft, onChange, errors, mode }: ScannerFieldsProps) {
  const currentMode = useMode();
  const events = useScanEvents(
    draft.orgId || undefined,
    Boolean(draft.orgId) && draft.accepts === 'event' && currentMode === mode,
  );
  const open = (events.data?.items ?? []).filter(
    (e) => e.orgId === draft.orgId && (e.status === 'upcoming' || e.status === 'live'),
  );
  return (
    <div className="@container grid min-w-0 gap-6">
      <section className="grid min-w-0 gap-4">
        <div>
          <h3 className="text-sm font-semibold text-fg-strong">Device details</h3>
          <p className="mt-1 text-xs text-fg-muted">Name the device and choose its purpose.</p>
        </div>
        <div className="grid min-w-0 gap-4">
          <FormField
            label="Name"
            required
            error={errors.name}
            help="Shown on scans as where they happened."
          >
            {(p) => (
              <Input
                {...p}
                autoComplete="off"
                maxLength={40}
                placeholder="Front door"
                value={draft.name}
                onChange={(e) => onChange({ name: e.target.value })}
              />
            )}
          </FormField>
        </div>
        <SetupFields draft={draft} onChange={onChange} errors={errors} />
      </section>
      {draft.deviceRole === 'scan' ? (
        <>
          <section className="grid min-w-0 gap-4 border-t border-border pt-6">
            <div>
              <h3 className="text-sm font-semibold text-fg-strong">Accepted passes</h3>
              <p className="mt-1 text-xs text-fg-muted">
                Choose which passes this scanner can check in.
              </p>
            </div>
            <SegmentedControl
              label="Accepts"
              options={[
                { value: 'all', label: 'All passes' },
                { value: 'event', label: 'An event' },
                { value: 'templates', label: 'Templates' },
              ]}
              value={draft.accepts}
              onValueChange={(accepts) => onChange({ accepts })}
            />
            {draft.accepts === 'event' ? (
              <FormField
                label="Event"
                required
                error={errors.eventId}
                help={open.length === 0 && !events.isPending ? 'No events yet.' : undefined}
              >
                {(p) => (
                  <Select
                    {...p}
                    value={draft.eventId || undefined}
                    placeholder="Pick an event"
                    onValueChange={(eventId) => onChange({ eventId })}
                    options={open.map((e) => ({ value: e.id, label: e.name }))}
                  />
                )}
              </FormField>
            ) : draft.accepts === 'templates' ? (
              <EligibleTemplatePicker
                orgId={draft.orgId}
                selected={draft.templateIds}
                onChange={(templateIds) => onChange({ templateIds })}
                mode={mode}
                error={errors.templateIds}
                errorId="scanner-templates-error"
              />
            ) : null}
          </section>
          <section className="grid min-w-0 gap-4 border-t border-border pt-6">
            <h3 className="text-sm font-semibold text-fg-strong">Check-in and staff</h3>
            <div className="grid min-w-0 gap-4 @[36rem]:grid-cols-2">
              <FormField
                label="On scan, tap or entered code"
                help="Name and email lookups always require confirmation."
              >
                {(p) => (
                  <Select
                    {...p}
                    value={draft.flow}
                    onValueChange={(v) => onChange({ flow: v as ScannerDraft['flow'] })}
                    options={FLOW}
                  />
                )}
              </FormField>
              {draft.adminUserId ? (
                <p className="text-xs text-fg-muted">
                  This admin-as-scanner setup uses the signed-in administrator’s Manager
                  permissions, not a staff PIN.
                </p>
              ) : draft.kind === 'terminal' ? (
                <p className="text-xs text-fg-muted">
                  Tills do not support staff PIN sign-in. They scan using their configured role.
                </p>
              ) : (
                <div className="grid content-start gap-1">
                  <CheckboxField
                    label="Ask staff for their PIN"
                    checked={draft.staffSignIn}
                    onCheckedChange={(c) => onChange({ staffSignIn: c === true })}
                  />
                  <p className="text-xs text-fg-muted">
                    Add staff and share their PINs from the Staff tab before enabling this. The
                    scanner requires sign-in to scan. Staff accounts are shared across this
                    organization’s live and test modes.
                  </p>
                </div>
              )}
              {!draft.adminUserId && (draft.kind === 'terminal' || !draft.staffSignIn) ? (
                <FormField label="Without sign-in, scans as">
                  {(p) => (
                    <Select
                      {...p}
                      value={draft.roleWithoutSignIn}
                      onValueChange={(v) =>
                        onChange({ roleWithoutSignIn: v as ScannerDraft['roleWithoutSignIn'] })
                      }
                      options={ROLE}
                    />
                  )}
                </FormField>
              ) : null}
              <FormField label="Let in again">
                {(p) => (
                  <Select
                    {...p}
                    value={draft.letInAgain}
                    onValueChange={(v) => onChange({ letInAgain: v as ScannerDraft['letInAgain'] })}
                    options={AGAIN}
                  />
                )}
              </FormField>
            </div>
          </section>
          <section className="grid min-w-0 gap-4 border-t border-border pt-6">
            <h3 className="text-sm font-semibold text-fg-strong">Device behavior</h3>
            <div className="grid min-w-0 gap-4 @[36rem]:grid-cols-2">
              <FormField label="Reader">
                {(p) => (
                  <Select
                    {...p}
                    value={draft.reader}
                    onValueChange={(v) => onChange({ reader: v as ScannerDraft['reader'] })}
                    options={READER}
                  />
                )}
              </FormField>
              <SwitchRow
                label="Look up people by name or email"
                checked={draft.lookup}
                onCheckedChange={(lookup) => onChange({ lookup })}
              />
              <FormField
                label="Daily limit"
                help="Optional. An amount, for scanners that take or add."
              >
                {(p) => (
                  <NumberField
                    {...p}
                    value={draft.dailyAmount}
                    min={1}
                    onValueChange={(dailyAmount) => onChange({ dailyAmount })}
                  />
                )}
              </FormField>
              <SwitchRow
                label="Show member photos"
                checked={draft.showPhoto}
                onCheckedChange={(showPhoto) => onChange({ showPhoto })}
              />
              <FormField label="Scan direction">
                {(p) => (
                  <Select
                    {...p}
                    value={draft.direction}
                    onValueChange={(direction) =>
                      onChange({ direction: direction as ScannerDraft['direction'] })
                    }
                    options={[
                      { value: 'pass', label: 'Use pass rules' },
                      { value: 'in', label: 'Entry only' },
                      { value: 'out', label: 'Exit only' },
                      { value: 'both', label: 'Entry and exit' },
                    ]}
                  />
                )}
              </FormField>
            </div>
          </section>
          <section className="grid min-w-0 gap-4 border-t border-border pt-6">
            <div>
              <h3 className="text-sm font-semibold text-fg-strong">Admission rules</h3>
              <p className="mt-1 text-xs text-fg-muted">
                Pass and template restrictions still apply.
              </p>
            </div>
            <CheckInFields
              orgId={draft.orgId}
              resourceMode={mode}
              rules={draft.checkIn}
              onChange={(checkIn) => onChange({ checkIn })}
            />
          </section>
        </>
      ) : null}
    </div>
  );
}
