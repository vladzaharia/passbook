import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { z } from 'zod';
import { pageOf } from '../../../shared/contracts/common.ts';
import { OrgListSchema } from '../../../shared/contracts/orgs.ts';
import type { ScanAdminScopeSchema } from '../../../shared/contracts/scan.ts';
import { ScanEventSchema } from '../../../shared/contracts/scanners.ts';
import { TemplateListSchema } from '../../../shared/contracts/templates.ts';
import { api } from '../../lib/api.ts';
import { errorMessage } from '../../lib/errors.ts';
import { getMode } from '../../lib/mode.ts';
import { localZone } from '../../lib/timezones.ts';
import { Button } from '../../ui/button.tsx';
import { CheckboxField } from '../../ui/checkbox.tsx';
import { FormField } from '../../ui/field.tsx';
import { ModeLabel } from '../../ui/layout/mode-label.tsx';
import { Select } from '../../ui/select.tsx';
import { BootCard } from '../ui/boot-card.tsx';

const Events = pageOf(ScanEventSchema);
export function AdminStart({
  onScope,
}: {
  onScope: (scope: z.infer<typeof ScanAdminScopeSchema>) => void;
}) {
  const [org, setOrg] = useState('');
  const [kind, setKind] = useState('templates');
  const [eventId, setEventId] = useState('');
  const [templateIds, setTemplateIds] = useState<string[]>([]);
  const orgs = useQuery({
    queryKey: ['scan', 'admin-orgs'],
    queryFn: ({ signal }) =>
      api.get('/api/v1/orgs', OrgListSchema, { query: { limit: 100 }, signal }),
  });
  const events = useQuery({
    queryKey: ['scan', 'admin-events', org],
    queryFn: ({ signal }) =>
      api.get('/api/v1/scan-events', Events, { query: { orgId: org, limit: 200 }, signal }),
    enabled: Boolean(org),
  });
  const templates = useQuery({
    queryKey: ['scan', 'admin-templates', org],
    queryFn: ({ signal }) =>
      api.get('/api/v1/templates', TemplateListSchema, {
        query: { orgId: org, limit: 200 },
        signal,
      }),
    enabled: Boolean(org),
  });
  const selectedEvent = events.data?.items.find((e) => e.id === eventId);
  const error = orgs.error ?? events.error ?? templates.error;
  return (
    <BootCard title="Scan as admin">
      <ModeLabel mode={getMode()} />
      <FormField label="Organization">
        {(p) => (
          <Select
            {...p}
            value={org}
            onValueChange={(value) => {
              setOrg(value);
              setEventId('');
              setTemplateIds([]);
            }}
            options={orgs.data?.items.map((o) => ({ value: o.id, label: o.name })) ?? []}
          />
        )}
      </FormField>
      {org ? (
        <>
          <FormField label="Accepts">
            {(p) => (
              <Select
                {...p}
                value={kind}
                onValueChange={setKind}
                options={[
                  { value: 'templates', label: 'Selected templates' },
                  { value: 'event', label: 'An event' },
                ]}
              />
            )}
          </FormField>
          {kind === 'event' ? (
            <FormField label="Event">
              {(p) => (
                <Select
                  {...p}
                  value={eventId}
                  onValueChange={setEventId}
                  options={
                    events.data?.items
                      .filter((e) => e.status !== 'archived')
                      .map((e) => ({ value: e.id, label: e.name })) ?? []
                  }
                />
              )}
            </FormField>
          ) : (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-sm font-medium">Templates</legend>
              {templates.data?.items
                .filter((t) => t.orgId === org && t.status === 'active')
                .map((t) => (
                  <CheckboxField
                    key={t.id}
                    label={t.name}
                    checked={templateIds.includes(t.id)}
                    onCheckedChange={(checked) =>
                      setTemplateIds((ids) =>
                        checked ? [...ids, t.id] : ids.filter((id) => id !== t.id),
                      )
                    }
                  />
                ))}
            </fieldset>
          )}
        </>
      ) : null}
      {error ? <p role="alert">{errorMessage(error)}</p> : null}
      <Button
        disabled={!org || (kind === 'event' ? !selectedEvent : !templateIds.length)}
        onClick={() =>
          onScope({
            orgId: org,
            timeZone: selectedEvent?.timeZone ?? localZone(),
            ...(kind === 'event' ? { eventId } : { templateIds }),
          })
        }
      >
        Continue
      </Button>
    </BootCard>
  );
}
