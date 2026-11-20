import { KEYSET_COPY } from '@/shared/copy/tag-keysets.ts';
import type { Keyset } from './api.ts';

export const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''));

export const kindOf = (k: Pick<Keyset, 'diversify' | 'perTag'>) =>
  k.perTag
    ? KEYSET_COPY.kind.own
    : k.diversify
      ? KEYSET_COPY.kind.diversified
      : KEYSET_COPY.kind.shared;

export const tagCount = (k: Keyset) => k.versions.reduce((sum, v) => sum + v.tags, 0);
export const activeVersion = (k: Keyset) => k.versions.find((v) => v.state === 'active');
export const retiringVersion = (k: Keyset) => k.versions.find((v) => v.state === 'retiring');

/** The URL a tag is written with: the host the console is on serves it. */
export const tagUrl = (slug: string) => `https://${window.location.host}/t/${slug}`;
