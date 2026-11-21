import type { ReactNode } from 'react';
import { Card, CardBody, CardHeader, ErrorState, KeyValue, SkeletonRows } from '@/web/ui/index.ts';
import { OrgChannelsCard } from '../channels/settings-channels.tsx';
import { PassEmailPreview } from '../orgs/pass-email-preview.tsx';
import { BrandSection } from './brand-section.tsx';
import { ORG_FIELDS } from './fields-org.ts';
import { useSettings } from './queries.ts';
import { ReplyToStatus } from './reply-to-status.tsx';
import { SettingsForm } from './settings-form.tsx';

/** The card is the section: rows render without their own heading. */
const inGroup = (group: string) =>
  ORG_FIELDS.filter((f) => f.group === group).map(({ group: _group, ...field }) => field);
const GENERAL = inGroup('General');
const PASS_EMAIL = inGroup('Pass email');
const EMAIL_LIMITS = inGroup('Email limits');
const SUPPORT = inGroup('Support');
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
  const value = (key: string) => {
    const current = query.data?.items.find((item) => item.key === key)?.value;
    if (typeof current === 'boolean') return current ? 'On' : 'Off';
    return current == null || current === '' ? 'Not set' : String(current);
  };
  return (
    <Card>
      <CardHeader title="Pass email and support" />
      <CardBody>
        {query.isPending ? (
          <SkeletonRows rows={3} label="Loading settings" />
        ) : query.isError ? (
          <ErrorState subject="settings" error={query.error} onRetry={() => query.refetch()} />
        ) : (
          <KeyValue
            items={[
              { label: 'Time zone', value: value('org.timeZone') },
              { label: 'Buddy in pass emails', value: value('email.buddy') },
              { label: 'Support email', value: value('support.email') },
              { label: 'Support URL', value: value('support.url') },
            ]}
          />
        )}
      </CardBody>
    </Card>
  );
}

/** The organization's own settings; an empty input follows the platform default. */
export function OrgSettingsSections({
  orgId,
  version,
  canManage,
  canPreviewTemplates,
}: {
  orgId: string;
  version: number;
  canManage: boolean;
  canPreviewTemplates: boolean;
}) {
  if (!canManage) return <ReadOnlySettings orgId={orgId} />;
  const scope = `org:${orgId}`;
  return (
    <>
      <BrandSection orgId={orgId} />
      <FormCard title="General">
        <SettingsForm scope={scope} fields={GENERAL} />
      </FormCard>
      <FormCard title="Pass email">
        <SettingsForm
          scope={scope}
          fields={PASS_EMAIL}
          aside={
            canPreviewTemplates
              ? (draft) => (
                  <PassEmailPreview
                    orgId={orgId}
                    buddy={draft['email.buddy'] === true}
                    version={version}
                  />
                )
              : undefined
          }
        />
        {!canPreviewTemplates ? (
          <p className="text-sm text-fg-muted">The email preview requires template read access.</p>
        ) : null}
      </FormCard>
      <FormCard title="Email limits">
        <SettingsForm scope={scope} fields={EMAIL_LIMITS} />
      </FormCard>
      <FormCard title="Support">
        <SettingsForm scope={scope} fields={SUPPORT} />
        <ReplyToStatus orgId={orgId} />
      </FormCard>
      <FormCard title="Privacy">
        <SettingsForm scope={scope} fields={PRIVACY} />
      </FormCard>
      <OrgChannelsCard orgId={orgId} />
    </>
  );
}
