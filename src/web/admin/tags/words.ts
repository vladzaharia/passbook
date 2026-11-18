import type { Tag, TagBinding } from '@/shared/contracts/nfc-tags.ts';
import { TAG_COPY } from '@/shared/copy/tags.ts';
import { formatDateTime, formatShortDate } from '@/web/lib/format.ts';

/** Fills `{name}` marks. A ` by {x}` or ` with {x}` clause whose value is missing drops out. */
export function fill(template: string, vars: Record<string, string | number | null | undefined>) {
  return template
    .replace(/ (?:by|with|·) \{(\w+)\}/g, (whole, key: string) =>
      vars[key] == null || vars[key] === '' ? '' : whole,
    )
    .replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key] ?? ''));
}

export const tagName = (tag: Pick<Tag, 'label'>) => tag.label ?? 'Tag';

/** The code as speech: "ends 7 F 3 A". */
export const hintSpoken = (hint: string) => `ends ${hint.split('').join(' ')}`;

export function worksWithLabel(binding: Pick<TagBinding, 'scope' | 'holderName'>): string {
  return binding.scope === 'user'
    ? fill(TAG_COPY.worksWith.person, { name: binding.holderName ?? 'the holder' })
    : TAG_COPY.worksWith.pass;
}

export function metaLine(tag: Tag): string {
  const b = tag.binding;
  if (!b) return `•• ${tag.hint}`;
  return fill(TAG_COPY.meta, {
    hint: tag.hint,
    date: formatShortDate(b.boundAt),
    staff: b.boundByName,
    scanner: b.scannerName,
  });
}

export function lastUsedLine(tag: Tag): string {
  if (tag.lastSeenAt === null) return TAG_COPY.neverUsed;
  return TAG_COPY.used.replace(' · {place}', '').replace('{when}', formatDateTime(tag.lastSeenAt));
}

export const lcFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
