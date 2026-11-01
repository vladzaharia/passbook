import { Badge, Card, CardLink, KeyValue, PageHeader } from '@/web/ui/index.ts';
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
    <section aria-labelledby="oidc-heading" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 id="oidc-heading" className="text-base font-semibold text-fg-strong">
            Polaris ID
          </h2>
          <Badge>Read-only</Badge>
        </div>
        <CardLink href={oidc.issuer}>Polaris ID</CardLink>
      </div>
      <Card className="p-4">
        <KeyValue
          items={[
            { label: 'Issuer', value: oidc.issuer, mono: true },
            { label: 'Admin group', value: oidc.adminGroup, mono: true },
            { label: 'User group', value: oidc.userGroup, mono: true },
          ]}
        />
      </Card>
    </section>
  );
}

export function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" />
      <div className="flex flex-col gap-8">
        <SettingsForm scope="platform" fields={PLATFORM_FIELDS} guard={guardMagicLink} />
        <OidcSection />
      </div>
    </>
  );
}
