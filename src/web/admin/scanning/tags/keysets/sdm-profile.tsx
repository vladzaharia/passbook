import { CodeBlock } from '@/web/ui/index.ts';
import type { Keyset } from './api.ts';
import { tagUrl } from './words.ts';

/** What the supplier or TagWriter must set on each tag. Without it real tags fail the check. */
export function sdmProfile(k: Pick<Keyset, 'slug' | 'diversify' | 'perTag'>): string {
  return [
    `URL      ${tagUrl(k.slug)}?p={PICC}&m={MAC}`,
    'PICC     encrypted (UID and read counter on) with the meta key',
    'MAC      over empty input, with the file key',
    k.perTag
      ? 'File key one key per tag, from your import'
      : k.diversify
        ? 'File key AN10922 from the master file key, input the UID only'
        : 'File key the file key, the same on every tag',
  ].join('\n');
}

export function SdmProfile({ keyset }: { keyset: Pick<Keyset, 'slug' | 'diversify' | 'perTag'> }) {
  return <CodeBlock label="Tag settings" code={sdmProfile(keyset)} wrap />;
}
