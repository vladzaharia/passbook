import type { BlueprintGroup } from '@/passkit/types.ts';
import type { TemplateSummaryDto } from '@/shared/contracts/templates.ts';

type Summary = TemplateSummaryDto;

/** The jobs a blueprint does, in the order the gallery shows them. */
export const GROUPS: readonly { id: BlueprintGroup | 'more'; label: string }[] = [
  { id: 'get-in', label: 'Get people in' },
  { id: 'save-spend', label: 'Save and spend' },
  { id: 'membership-id', label: 'Membership and ID' },
  { id: 'prove-collect', label: 'Prove and collect' },
  { id: 'more', label: 'More' },
];

/** Order inside the groups; a blueprint not listed follows, by name. */
const ORDER = [
  'event-ticket',
  'multi-day-pass',
  'boarding-pass',
  'access-card',
  'monthly-pass',
  'day-pass',
  'guest-pass',
  'visitor-pass',
  'staff-badge',
  'timed-ticket',
  'transit-ticket',
  'booking',
  'hotel-stay',
  'stamp-card',
  'store-card',
  'coupon',
  'pack',
  'generic',
  'id-card',
  'credential',
  'poster-generic',
  'pickup',
  'permit',
];
const slugOf = (b: Summary) => b.id.replace(/^.*starter-/, '');
const rank = (b: Summary) => {
  const i = ORDER.indexOf(slugOf(b));
  return i < 0 ? ORDER.length : i;
};

/** One tile: a blueprint, or the Access card with its Member / Staff choice. */
export interface Entry {
  id: string;
  group: BlueprintGroup | 'more';
  variants: { label: string; blueprint: Summary }[];
}

const ACCESS = [
  { slug: 'access-card', label: 'Member' },
  { slug: 'staff-badge', label: 'Staff' },
] as const;

const groupOf = (b: Summary): Entry['group'] =>
  GROUPS.some((g) => g.id === b.group) ? (b.group as Entry['group']) : 'more';

/** The Access card and the Staff badge are two blueprints behind one tile, once both exist. */
export function entriesOf(items: readonly Summary[]): Entry[] {
  const sorted = [...items].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const pair = ACCESS.map((a) => sorted.find((b) => slugOf(b) === a.slug));
  const [card, badge] = pair;
  const joined = card && badge;
  return sorted.flatMap((b): Entry[] => {
    if (joined && b === badge) return [];
    if (joined && b === card)
      return [
        {
          id: b.id,
          group: groupOf(b),
          variants: ACCESS.map((a, i) => ({
            label: a.label,
            blueprint: pair[i] as Summary,
          })),
        },
      ];
    return [{ id: b.id, group: groupOf(b), variants: [{ label: b.name, blueprint: b }] }];
  });
}

/** Every word of the query must be found in a name, line, alias or group of some variant. */
export function matches(entry: Entry, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const label = GROUPS.find((g) => g.id === entry.group)?.label ?? '';
  const hay = entry.variants
    .flatMap(({ blueprint: b }) => [b.name, b.description ?? '', ...b.aliases])
    .concat(label)
    .join(' ')
    .toLowerCase();
  return words.every((w) => hay.includes(w));
}

export function groupEntries(entries: readonly Entry[]) {
  return GROUPS.map((g) => ({ ...g, entries: entries.filter((e) => e.group === g.id) })).filter(
    (g) => g.entries.length > 0,
  );
}
