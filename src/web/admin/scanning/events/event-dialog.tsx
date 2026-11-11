import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { type ScanEventDto, ScanEventSchema } from '@/shared/contracts/scanners.ts';
import { api } from '@/web/lib/api.ts';
import { errorMessage } from '@/web/lib/errors.ts';
import { localZone } from '@/web/lib/timezones.ts';
import { CheckboxField } from '@/web/ui/checkbox.tsx';
import { DateTimeField, type DateTimeValue } from '@/web/ui/date-time-field.tsx';
import {
  Button,
  Callout,
  Dialog,
  DialogContent,
  Form,
  FormField,
  Input,
  useFormErrors,
} from '@/web/ui/index.ts';
import { isoToLocal, localToIso } from '../../passes/schema-form/datetime.ts';
import { EligibleTemplatePicker } from '../eligible-template-picker.tsx';

export function EventDialog({
  orgId,
  event,
  onClose,
}: {
  orgId: string;
  event?: ScanEventDto;
  onClose: () => void;
}) {
  const zone = event?.timeZone ?? localZone();
  const client = useQueryClient();
  const [name, setName] = useState(event?.name ?? '');
  const [opens, setOpens] = useState<DateTimeValue | null>({
    local: event ? isoToLocal(new Date(event.opensAt).toISOString(), zone) : '',
    zone,
  });
  const [closes, setCloses] = useState<DateTimeValue | null>({
    local: event ? isoToLocal(new Date(event.closesAt).toISOString(), zone) : '',
    zone,
  });
  const [selected, setSelected] = useState(event?.templateIds ?? []);
  const [capacity, setCapacity] = useState(event?.capacity?.toString() ?? '');
  const [note, setNote] = useState(event?.note ?? '');
  const [reentry, setReentry] = useState(event?.reentry ?? false);
  const [matchInput, setMatchInput] = useState(event?.match?.input ?? '');
  const [matchValues, setMatchValues] = useState(event?.match?.values.join(', ') ?? '');
  const check = useFormErrors({
    values:
      matchInput.trim() && !matchValues.trim() ? 'Enter at least one matching value.' : undefined,
  });
  const mutation = useMutation({
    mutationFn: async () => {
      const body = {
        orgId,
        name,
        templateIds: selected,
        opensAt: Date.parse(localToIso(opens?.local ?? '', opens?.zone ?? zone) ?? ''),
        closesAt: Date.parse(localToIso(closes?.local ?? '', closes?.zone ?? zone) ?? ''),
        timeZone: opens?.zone ?? zone,
        capacity: capacity ? Number(capacity) : null,
        note: note.trim() || null,
        reentry,
        match: matchInput.trim()
          ? {
              input: matchInput.trim(),
              values: matchValues
                .split(',')
                .map((v) => v.trim())
                .filter(Boolean),
            }
          : null,
      };
      if (
        !Number.isFinite(body.opensAt) ||
        !Number.isFinite(body.closesAt) ||
        body.closesAt <= body.opensAt
      )
        throw new Error('Closing must be after opening.');
      if (body.match && !body.match.values.length)
        throw new Error('Enter at least one matching value.');
      return event
        ? api.action('PATCH', `/api/v1/scan-events/${encodeURIComponent(event.id)}`, body)
        : api.post('/api/v1/scan-events', ScanEventSchema, body);
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['admin', 'scanning', 'events'] });
      onClose();
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogContent title={event ? 'Edit event' : 'New event'} size="md">
        <Form {...check.form} className="flex flex-col gap-4" onValid={() => mutation.mutate()}>
          <FormField label="Name">
            {(p) => (
              <Input
                {...p}
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={80}
              />
            )}
          </FormField>
          <EligibleTemplatePicker
            orgId={orgId}
            selected={selected}
            onChange={setSelected}
            requireCheckIn
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Only passes where" help="Input name; optional">
              {(p) => (
                <Input
                  {...p}
                  value={matchInput}
                  onChange={(e) => setMatchInput(e.target.value)}
                  maxLength={64}
                />
              )}
            </FormField>
            <FormField label="Equals" help="Values separated by commas" error={check.errors.values}>
              {(p) => (
                <Input
                  {...p}
                  value={matchValues}
                  onChange={(e) => setMatchValues(e.target.value)}
                />
              )}
            </FormField>
          </div>
          <p className="text-xs text-fg-muted">
            Leave empty to admit every pass of these templates.
          </p>
          <FormField label="Scanning opens">
            {(p) => (
              <DateTimeField
                {...p}
                value={opens}
                onChange={(value) => {
                  setOpens(value);
                  if (value && closes) setCloses({ ...closes, zone: value.zone });
                }}
                clearLabel="No opening time"
                defaultZone={zone}
              />
            )}
          </FormField>
          <FormField label="Scanning closes">
            {(p) => (
              <DateTimeField
                {...p}
                value={closes}
                onChange={setCloses}
                clearLabel="No closing time"
                defaultZone={zone}
              />
            )}
          </FormField>
          <FormField label="Capacity" help="Optional">
            {(p) => (
              <Input
                {...p}
                type="number"
                min={1}
                value={capacity}
                onChange={(e) => setCapacity(e.target.value)}
              />
            )}
          </FormField>
          <CheckboxField
            label="Allow re-entry"
            checked={reentry}
            onCheckedChange={(value) => setReentry(value === true)}
          />
          <FormField
            label="Note for staff"
            help="Shown at the start and on heads-up and refused results."
          >
            {(p) => (
              <Input
                {...p}
                maxLength={140}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            )}
          </FormField>
          <p className="-mt-2 text-right text-xs text-fg-muted">{note.length}/140</p>
          {mutation.isError ? (
            <Callout tone="danger">{errorMessage(mutation.error)}</Callout>
          ) : null}
          <Button
            type="submit"
            loading={mutation.isPending}
            disabled={!name.trim() || !opens?.local || !closes?.local || !selected.length}
          >
            {event ? 'Save event' : 'Create event'}
          </Button>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
