import { ExternalLink } from 'lucide-react';
import { Badge, Card, KeyValue, PageHeader } from '@/web/ui/index.ts';
import { PLATFORM_FIELDS } from './fields.ts';
import { useSettings } from './queries.ts';
import { SettingsForm } from './settings-form.tsx';

function OidcSection() {
  const { data } = useSettings('platform');
  if (!data) return null;
  const { oidc } = data;
  return (
    <section aria-labelledby="oidc-heading" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 id="oidc-heading" className="text-base font-semibold text-fg-strong">
          Polaris ID
        </h2>
        <Badge>Read-only</Badge>
      </div>
      <Card className="p-4">
        <KeyValue
          items={[
            { label: 'Issuer', value: oidc.issuer, mono: true },
            { label: 'Admin group', value: oidc.adminGroup, mono: true },
            { label: 'User group', value: oidc.userGroup, mono: true },
          ]}
        />
        <a
          className="mt-4 inline-flex min-h-6 items-center gap-1 text-sm text-accent-fg underline"
          href={oidc.issuer}
          target="_blank"
          rel="noreferrer noopener"
        >
          Polaris ID
          <ExternalLink aria-hidden className="size-3.5" />
        </a>
      </Card>
    </section>
  );
}

export function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" />
      <div className="flex flex-col gap-8">
        <SettingsForm scope="platform" fields={PLATFORM_FIELDS} />
        <OidcSection />
      </div>
    </>
  );
}
