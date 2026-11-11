import {
  Badge,
  Callout,
  Card,
  CardBody,
  CardHeader,
  CardLink,
  KeyValue,
  PageHeader,
} from '@/web/ui/index.ts';
import { PLATFORM_FIELDS } from './fields.ts';
import { MagicLinkImpact } from './magic-link-impact.tsx';
import { useSettings } from './queries.ts';
import { type SaveGuard, SettingsForm } from './settings-form.tsx';

/** Turning magic links off locks out everyone without Polaris ID: confirm with the count. */
function guardMagicLink(values: Record<string, unknown>): SaveGuard | null {
  if (values['auth.magicLinkEnabled'] !== false) return null;
  return {
    key: 'auth.magicLinkEnabled',
    title: 'Turn off magic-link sign-in?',
    description: <MagicLinkImpact />,
    confirmLabel: 'Turn off',
  };
}

function OidcSection() {
  const { data } = useSettings('platform');
  if (!data) return null;
  const { oidc } = data;
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            Polaris ID <Badge>Read-only</Badge>
          </span>
        }
        actions={<CardLink href={oidc.issuer}>Open Polaris ID</CardLink>}
      />
      <CardBody>
        <KeyValue
          items={[
            { label: 'Issuer', value: oidc.issuer, mono: true },
            { label: 'Admin group', value: oidc.adminGroup, mono: true },
            { label: 'User group', value: oidc.userGroup, mono: true },
          ]}
        />
      </CardBody>
    </Card>
  );
}

/** Card sections like org detail; a dirty form's SaveBar room is at the end of main (AppShell). */
export function SettingsPage() {
  return (
    <>
      <PageHeader
        title="Platform settings"
        breadcrumbs={[{ label: 'Platform' }, { label: 'Settings' }]}
        meta="Platform policy · All organizations · Live and Test"
      />
      <div className="flex flex-col gap-6">
        <Callout tone="info" title="Shared across Live and Test">
          Test mode does not isolate global settings.
        </Callout>
        <SettingsForm scope="platform" fields={PLATFORM_FIELDS} guard={guardMagicLink} />
        <OidcSection />
      </div>
    </>
  );
}
