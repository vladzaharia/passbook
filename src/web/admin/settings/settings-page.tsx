import { Badge, Card, CardBody, CardHeader, KeyValue, PageHeader } from '@/web/ui/index.ts';
import { PLATFORM_FIELDS } from './fields.ts';
import { useSettings } from './queries.ts';
import { SettingsForm } from './settings-form.tsx';

function OidcCard() {
  const { data } = useSettings('platform');
  if (!data) return null;
  const { oidc } = data;
  return (
    <Card>
      <CardHeader title="Pocket ID" actions={<Badge>Read-only</Badge>} />
      <CardBody>
        <KeyValue
          items={[
            { label: 'Issuer', value: oidc.issuer, mono: true },
            { label: 'Admin group', value: oidc.adminGroup, mono: true },
            { label: 'User group', value: oidc.userGroup, mono: true },
          ]}
        />
        <p className="mt-3 text-sm text-fg-muted">
          Managed in{' '}
          <a
            className="text-accent-fg underline"
            href="https://id.plrs.im"
            target="_blank"
            rel="noreferrer noopener"
          >
            Pocket ID
          </a>
          .
        </p>
      </CardBody>
    </Card>
  );
}

export function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" />
      <div className="flex max-w-2xl flex-col gap-6">
        <Card>
          <CardHeader title="Platform" />
          <CardBody>
            <SettingsForm scope="platform" fields={PLATFORM_FIELDS} />
          </CardBody>
        </Card>
        <OidcCard />
      </div>
    </>
  );
}
