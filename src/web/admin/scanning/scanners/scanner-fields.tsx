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
import { useOrgTemplates, useScanEvents } from '../scanner-api.ts';
import type { ScannerDraft } from './scanner-draft.ts';

export interface ScannerFieldsProps {
  draft: ScannerDraft;
  onChange: (patch: Partial<ScannerDraft>) => void;
  errors: Partial<Record<string, string>>;
  /** The org picker shows only with All organizations in scope. */
  orgs?: readonly { id: string; name: string }[] | undefined;
  autoFocus?: boolean;
}

const FLOW = [
  { value: 'auto', label: 'Do the first action at once' },
  { value: 'choose', label: 'Show the actions' },
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

/** The scanner's settings, as the New scanner dialog and the detail page's Settings card show them. */
export function ScannerFields({ draft, onChange, errors, orgs, autoFocus }: ScannerFieldsProps) {
  const events = useScanEvents(draft.orgId || undefined, draft.accepts === 'event');
  const open = (events.data?.items ?? []).filter(
    (e) => e.status === 'upcoming' || e.status === 'live',
  );
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <FormField
        label="Name"
        required
        error={errors.name}
        help="Shown on scans as where they happened."
      >
        {(p) => (
          <Input
            {...p}
            data-autofocus={autoFocus ? '' : undefined}
            autoComplete="off"
            maxLength={40}
            placeholder="Front door"
            value={draft.name}
            onChange={(e) => onChange({ name: e.target.value })}
          />
        )}
      </FormField>
      {orgs ? (
        <FormField label="Organization" required error={errors.orgId}>
          {(p) => (
            <Select
              {...p}
              value={draft.orgId || undefined}
              placeholder="Pick an organization"
              onValueChange={(orgId) => onChange({ orgId, eventId: '', templateIds: [] })}
              options={orgs.map((o) => ({ value: o.id, label: o.name }))}
            />
          )}
        </FormField>
      ) : null}
      <div className="flex flex-col gap-2">
        <SegmentedControl
          label="Accepts"
          options={[
            { value: 'event', label: 'An event' },
            { value: 'templates', label: 'Templates' },
          ]}
          value={draft.accepts}
          onValueChange={(accepts) => onChange({ accepts })}
        />
      </div>
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
      ) : (
        <TemplateRows draft={draft} onChange={onChange} error={errors.templateIds} />
      )}
      <FormField label="On scan" help="Staff can still pick another action.">
        {(p) => (
          <Select
            {...p}
            value={draft.flow}
            onValueChange={(v) => onChange({ flow: v as ScannerDraft['flow'] })}
            options={FLOW}
          />
        )}
      </FormField>
      <CheckboxField
        label="Ask staff for their PIN"
        disabled={!draft.staffSignIn}
        checked={draft.staffSignIn}
        onCheckedChange={(c) => onChange({ staffSignIn: c === true })}
      />
      <p className="text-xs text-fg-muted">Staff sign-in is unavailable.</p>
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
        label="Look up by name"
        checked={draft.lookup}
        onCheckedChange={(lookup) => onChange({ lookup })}
      />
      <FormField label="Daily limit" help="Optional. An amount, for scanners that take or add.">
        {(p) => (
          <NumberField
            {...p}
            value={draft.dailyAmount}
            min={1}
            onValueChange={(dailyAmount) => onChange({ dailyAmount })}
          />
        )}
      </FormField>
    </div>
  );
}
