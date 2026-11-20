import { CopyButton, KeyValue } from '@/web/ui/index.ts';
import type { Keyset } from './api.ts';
import { tagUrl } from './words.ts';

/** What the supplier or TagWriter must set on each tag. Without it real tags fail the check. */
export function SdmProfile({ keyset }: { keyset: Pick<Keyset, 'slug' | 'diversify' | 'perTag'> }) {
  const url = `${tagUrl(keyset.slug)}?p={PICC}&m={MAC}`;
  return (
    <section
      aria-label="Tag settings"
      className="rounded-md border border-border bg-surface-sunken p-3"
    >
      <KeyValue
        items={[
          {
            label: 'URL',
            value: (
              <span className="flex items-start gap-1">
                <span className="min-w-0 break-all">{url}</span>
                <CopyButton value={url} label="Copy tag URL template" />
              </span>
            ),
            mono: true,
          },
          { label: 'PICC data', value: 'Encrypted with the meta key; UID and read counter on' },
          { label: 'MAC', value: 'Over empty input, with the file key' },
          {
            label: 'File key',
            value: keyset.perTag
              ? 'One per tag, from your import'
              : keyset.diversify
                ? 'AN10922 from the master file key, input the UID only'
                : 'The file key, the same on every tag',
          },
        ]}
      />
    </section>
  );
}
