import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardLink,
  KeyValue,
  PageHeader,
  TechnicalDetails,
} from '@/web/ui/index.ts';
import { PlatformChannelsCards } from '../channels/settings-channels.tsx';
import { PLATFORM_FIELDS } from './fields-platform.ts';
import type { SaveGuard } from './form-values.ts';
import { MagicLinkImpact } from './magic-link-impact.tsx';
import { useSettings } from './queries.ts';
import { SettingsForm } from './settings-form.tsx';

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
            {
              label: 'Pinned platform admins',
              value: oidc.platformAdminPinned > 0 ? String(oidc.platformAdminPinned) : 'Off',
            },
            { label: 'Admin group required', value: oidc.consoleGroupRequired ? 'On' : 'Off' },
          ]}
        />
        <TechnicalDetails
          className="mt-3"
          items={[
            { label: 'Issuer', value: oidc.issuer, copy: true },
            {
              label: 'Platform admin group',
              value: oidc.platformAdminGroup.join(', ') || null,
              copy: true,
            },
            { label: 'Admin group', value: oidc.adminGroup.join(', ') || null, copy: true },
            { label: 'Developer group', value: oidc.developerGroup.join(', ') || null, copy: true },
            { label: 'User group', value: oidc.userGroup.join(', ') || null, copy: true },
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
      />
      <div className="flex flex-col gap-6">
        <SettingsForm scope="platform" fields={PLATFORM_FIELDS} guard={guardMagicLink} />
        <PlatformChannelsCards />
        <OidcSection />
      </div>
    </>
  );
}
