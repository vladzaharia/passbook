import {
  Checkbox,
  CheckboxField,
  FormField,
  Input,
  Label,
  NumberField,
  SegmentedControl,
  Select,
  SwitchRow,
} from '@/web/ui/index.ts';
import { CheckInFields } from '../check-in-fields.tsx';
import { useOrgTemplates, useScanEvents } from '../scanner-api.ts';
import type { ScannerDraft } from './scanner-draft.ts';
import { SetupFields } from './setup-fields.tsx';

export interface ScannerFieldsProps {
  draft: ScannerDraft;
  onChange: (patch: Partial<ScannerDraft>) => void;
  errors: Partial<Record<string, string>>;
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

function TemplateRows({
  draft,
  onChange,
  error,
}: Pick<ScannerFieldsProps, 'draft' | 'onChange'> & { error?: string | undefined }) {
  const templates = useOrgTemplates(draft.orgId || undefined);
  const items = (templates.data?.items ?? []).filter(
    (t) => t.status === 'active' && t.orgId === draft.orgId,
  );
  const set = (id: string, on: boolean) =>
    onChange({
      templateIds: on ? [...draft.templateIds, id] : draft.templateIds.filter((x) => x !== id),
    });
  return (
    <fieldset
      className="flex min-w-0 flex-col"
      aria-describedby={error ? 'scanner-templates-error' : undefined}
    >
      <legend className="mb-2 text-sm font-medium text-fg">Templates</legend>
      <ul className="divide-y divide-border rounded-md border border-border-strong">
        {items.length === 0 ? (
          <li className="px-3 py-2 text-sm text-fg-muted">
            {templates.isPending && draft.orgId ? 'Loading…' : 'No templates yet.'}
          </li>
        ) : null}
        {items.map((t, i) => (
          <li key={t.id} className="flex min-h-11 items-center gap-3 px-3 py-2">
            <Checkbox
              id={`scanner-t-${t.id}`}
              aria-invalid={error && i === 0 ? true : undefined}
              checked={draft.templateIds.includes(t.id)}
              onCheckedChange={(c) => set(t.id, c === true)}
            />
            <Label htmlFor={`scanner-t-${t.id}`} className="min-w-0 flex-1 font-normal">
              {t.name}
            </Label>
          </li>
        ))}
      </ul>
      {error ? (
        <p id="scanner-templates-error" className="mt-1 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

/** The legacy scanner settings form, shown on existing standalone scanner records. */
export function ScannerFields({ draft, onChange, errors }: ScannerFieldsProps) {
  const events = useScanEvents(draft.orgId || undefined, draft.accepts === 'event');
  const open = (events.data?.items ?? []).filter(
    (e) => e.status === 'upcoming' || e.status === 'live',
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
              <TemplateRows draft={draft} onChange={onChange} error={errors.templateIds} />
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
              <div className="grid content-start gap-1">
                <CheckboxField
                  label="Ask staff for their PIN"
                  disabled={!draft.staffSignIn}
                  checked={draft.staffSignIn}
                  onCheckedChange={(c) => onChange({ staffSignIn: c === true })}
                />
                <p className="text-xs text-fg-muted">Staff sign-in is unavailable.</p>
              </div>
              {draft.staffSignIn ? null : (
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
              )}
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
              rules={draft.checkIn}
              onChange={(checkIn) => onChange({ checkIn })}
            />
          </section>
        </>
      ) : null}
    </div>
  );
}
