import type { ReactNode } from 'react';
import { DEFAULT_TIME_ZONE, DEFAULT_TIME_ZONE_LABEL } from '@/shared/time-zone.ts';
import { zoneLabel } from '@/web/lib/timezones.ts';
import { Card, CardBody, CardHeader, ErrorState, KeyValue, SkeletonRows } from '@/web/ui/index.ts';
import { ORG_FIELDS } from './fields-org.ts';
import { useSettings } from './queries.ts';
import { SettingsForm } from './settings-form.tsx';

/** The card is the section: rows render without their own heading. */
const inGroup = (group: string) =>
  ORG_FIELDS.filter((f) => f.group === group).map(({ group: _group, ...field }) => field);
const GENERAL = inGroup('General');
const EMAIL_LIMITS = inGroup('Email limits');
const PRIVACY = inGroup('Privacy');

function FormCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader title={title} />
      <CardBody className="flex flex-col gap-4">{children}</CardBody>
    </Card>
  );
}

/** What a member without org:manage sees: the effective values. */
function ReadOnlySettings({ orgId }: { orgId: string }) {
  const query = useSettings(`org:${orgId}`);
  const zoneEntry = query.data?.items.find((item) => item.key === 'org.timeZone');
  const zoneValue = () => {
    const zone = typeof zoneEntry?.value === 'string' ? zoneEntry.value : DEFAULT_TIME_ZONE;
    const name = zone === DEFAULT_TIME_ZONE ? DEFAULT_TIME_ZONE_LABEL : zoneLabel(zone);
    return zoneEntry?.source === 'org' ? name : `${name} · default`;
  };
  return (
    <Card>
      <CardHeader title="General" />
      <CardBody>
        {query.isPending ? (
          <SkeletonRows rows={3} label="Loading settings" />
        ) : query.isError ? (
          <ErrorState subject="settings" error={query.error} onRetry={() => query.refetch()} />
        ) : (
          <KeyValue items={[{ label: 'Time zone', value: zoneValue() }]} />
        )}
      </CardBody>
    </Card>
  );
}

/** The organization's own settings; an empty input follows the platform default. */
export function OrgSettingsSections({ orgId, canManage }: { orgId: string; canManage: boolean }) {
  if (!canManage) return <ReadOnlySettings orgId={orgId} />;
  const scope = `org:${orgId}`;
  return (
    <>
      <FormCard title="General">
        <SettingsForm scope={scope} fields={GENERAL} />
      </FormCard>
      <FormCard title="Email limits">
        <SettingsForm scope={scope} fields={EMAIL_LIMITS} />
      </FormCard>
      <FormCard title="Privacy">
        <SettingsForm scope={scope} fields={PRIVACY} />
      </FormCard>
    </>
  );
}
