import { formatDay } from '@/web/lib/format.ts';
import { KeyValue, SecretReveal } from '@/web/ui/index.ts';
import type { ApiKey } from './queries.ts';

/** The one-time key on the kit's SecretReveal, with the credential it belongs to beneath. */
export function KeyDisclosure({
  created,
  organization,
  onDone,
}: {
  created: ApiKey & { secret: string };
  organization: string;
  onDone: () => void;
}) {
  return (
    <SecretReveal
      fields={[{ label: 'API key', value: created.secret, copyLabel: 'Copy API key' }]}
      savedLabel="I saved the key"
      onDone={onDone}
    >
      <KeyValue
        items={[
          { label: 'Name', value: created.name },
          { label: 'Organization', value: organization },
          { label: 'Mode', value: created.mode === 'test' ? 'Test' : 'Live' },
          { label: 'Permissions', value: created.scopes.join(', ') },
          { label: 'Expiry', value: formatDay(created.expiresAt, 'Never') },
        ]}
      />
    </SecretReveal>
  );
}
