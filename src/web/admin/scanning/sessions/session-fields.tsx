import { useState } from 'react';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import { zoneOptions } from '@/web/lib/timezones.ts';
import {
  FormField,
  Input,
  SegmentedControl,
  Select,
  SwitchRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/web/ui/index.ts';
import { CheckInFields } from '../check-in-fields.tsx';
import { EligibleTemplatePicker } from '../eligible-template-picker.tsx';
import { useScanEvents } from '../scanner-api.ts';
import type { SessionDraft as ScannerDraft } from './draft.ts';

function SessionScope({
  draft,
  set,
}: {
  draft: ScannerDraft;
  set: (patch: Partial<ScannerDraft>) => void;
}) {
  const _scope = useOrgScope();
  const events = useScanEvents(
    draft.orgId || undefined,
    Boolean(draft.orgId) && draft.accepts === 'event',
  );
  return (
    <div className="grid gap-4">
      <FormField label="Session name" required>
        {(p) => (
          <Input
            {...p}
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
      <SegmentedControl
        label="Accepted passes"
        value={draft.accepts}
        onValueChange={(accepts) => set({ accepts })}
        options={[
          { value: 'all', label: 'All passes' },
          { value: 'event', label: 'Event' },
          { value: 'templates', label: 'Templates' },
        ]}
        block
      />
      {draft.accepts === 'event' ? (
        <FormField label="Event" required>
          {(p) => (
            <Select
              {...p}
              value={draft.eventId || undefined}
              options={(events.data?.items ?? [])
                .filter(
                  (e) =>
                    e.orgId === draft.orgId && (e.status === 'upcoming' || e.status === 'live'),
                )
                .map((e) => ({ value: e.id, label: e.name }))}
              onValueChange={(eventId) => set({ eventId })}
            />
          )}
        </FormField>
      ) : null}
      {draft.accepts === 'templates' ? (
        <EligibleTemplatePicker
          orgId={draft.orgId}
          selected={draft.templateIds}
          onChange={(templateIds) => set({ templateIds })}
        />
      ) : null}
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
          Staff and PINs are shared across the organization. Admin-as-scanner sessions use the
          signed-in administrator’s Manager permissions.
        </p>
      </div>
      <SwitchRow
        label="Require staff sign-in"
        help="Applies only to paired, staff-operated scanner devices. Bearer-token terminals do not use staff PINs and always use the access level below."
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
    </section>
  );
}
export function SessionFields({
  draft,
  set,
}: {
  draft: ScannerDraft;
  set: (patch: Partial<ScannerDraft>) => void;
}) {
  const [tab, setTab] = useState('passes');
  return (
    <Tabs value={tab} onValueChange={setTab} className="@container min-w-0">
      <TabsList aria-label="Session settings">
        <TabsTrigger value="passes">Passes</TabsTrigger>
        <TabsTrigger value="rules">Admission</TabsTrigger>
        <TabsTrigger value="defaults">Device defaults</TabsTrigger>
      </TabsList>
      <TabsContent value="passes">
        <SessionScope draft={draft} set={set} />
      </TabsContent>
      <TabsContent value="rules">
        <CheckInFields
          orgId={draft.orgId}
          timeZone={draft.timeZone}
          rules={draft.checkIn}
          onChange={(checkIn) => set({ checkIn })}
        />
        <SessionStaff draft={draft} set={set} />
      </TabsContent>
      <TabsContent value="defaults">
        <SessionDefaults draft={draft} set={set} />
      </TabsContent>
    </Tabs>
  );
}
