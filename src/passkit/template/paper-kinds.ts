/**
 * Per-class reading of a pass for paper: which facts lead on the door panel and the holder panel.
 * `kindOf` derives the class when the paper block has none; `kindContent` reads the facts, only
 * through the guarded `field` reader so no credential or lookup value can reach the sheet.
 */
import type { PassStyle, TemplateManifest } from '../types.ts';
import type { ResolvedRoles, RoleValue } from '../wallets/types.ts';
import type { PaperKind } from './paper.ts';

export interface Kinded {
  kind: PaperKind;
  roles: ResolvedRoles;
  /** The first named field with printable text; credentials and the lookup value read as absent. */
  field: (...keys: string[]) => string | undefined;
  semantics: Record<string, unknown>;
  holderName?: string | undefined;
  /** The lookup value, when the template declares it public: a permit prints it as the plate. */
  publicLookup?: string | undefined;
  /** The template's own start and end times (ISO), read from its inputs; never the lock-screen date. */
  declared?: { start?: string | undefined; end?: string | undefined } | undefined;
}

export interface KindParts {
  title?: string;
  kicker?: string;
  start?: string;
  end?: string;
  doors?: string;
  validFrom?: string;
  validUntil?: string;
  venue?: string;
  address?: string;
  room?: string;
  directions?: string;
  holder?: string;
  type?: string;
  seat?: { section?: string; row?: string; seat?: string };
  facts: { label: string; text: string }[];
  items?: string[];
  hero?: { zone?: string; plate?: string; offer?: string; offerNote?: string; name?: string };
}

const text = (v: RoleValue | undefined): string | undefined =>
  v && (v.kind === 'text' || v.kind === 'number') ? v.text : undefined;
const iso = (v: RoleValue | undefined): string | undefined =>
  v?.kind === 'date' ? v.iso : undefined;
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;
export const ISO = /^\d{4}-\d{2}-\d{2}T/;

type Slice = Pick<TemplateManifest, 'display' | 'scan'>;

/** The class when the paper block names none: coupon, permit, pickup, membership, else admission. */
export function kindOf(
  manifest: Slice,
  style: PassStyle | undefined,
  roles: ResolvedRoles,
): PaperKind {
  if (style === 'coupon') return 'coupon';
  if (style === 'eventTicket' || style === 'boardingPass' || roles.eventStart) return 'admission';
  const group = (manifest.display as { group?: string } | undefined)?.group;
  if (group === 'prove-collect')
    return (manifest.scan as { window?: unknown } | undefined)?.window ? 'permit' : 'pickup';
  if (style === 'storeCard' || group === 'membership-id' || roles.memberName) return 'membership';
  return 'admission';
}

const when = (c: Kinded, role: RoleValue | undefined, ...keys: string[]) => {
  const fromRole = iso(role);
  if (fromRole) return fromRole;
  const value = c.field(...keys);
  return value && ISO.test(value) ? value : undefined;
};

/** Reads the shared facts, then the class's own. */
export function kindContent(c: Kinded): KindParts {
  const { roles, field, semantics } = c;
  const seat = {
    ...(text(roles.section) ? { section: text(roles.section) as string } : {}),
    ...(text(roles.row) ? { row: text(roles.row) as string } : {}),
    ...(text(roles.seat) ? { seat: text(roles.seat) as string } : {}),
  };
  const holder =
    text(roles.ticketHolder) ??
    text(roles.memberName) ??
    field('attendee', 'holder', 'memberName', 'name') ??
    (c.kind === 'coupon' || c.kind === 'permit' ? undefined : c.holderName);
  const start = when(c, roles.eventStart, 'date', 'time') ?? c.declared?.start;
  const timed = c.kind === 'admission' && Boolean(start);
  const parts: KindParts = {
    start,
    end: iso(roles.eventEnd) ?? c.declared?.end,
    doors: when(c, roles.doorsOpen, 'doors'),
    // An event's own times are its validity; the wallet's relevance dates are not a validity range.
    validFrom: when(c, timed ? undefined : roles.validFrom, 'validFrom'),
    validUntil: when(
      c,
      timed ? undefined : roles.validUntil,
      'until',
      'validTo',
      'expires',
      'collectBy',
    ),
    venue: text(roles.venueName) ?? field('venue'),
    address: text(roles.venueAddress) ?? str(semantics.venueRegionName) ?? field('address'),
    room: str(semantics.venueRoom) ?? field('room', 'entrance'),
    directions: field('directions'),
    holder,
    type:
      text(roles.tier) ?? str(semantics.admissionLevel) ?? field('admission', 'plan', 'membership'),
    facts: [],
  };
  const drop = (key: keyof KindParts) => {
    if (parts[key] === undefined) delete parts[key];
  };
  for (const key of [
    'start',
    'end',
    'doors',
    'validFrom',
    'validUntil',
    'venue',
    'address',
    'room',
    'directions',
    'holder',
    'type',
  ] as const)
    drop(key);

  if (c.kind === 'admission') {
    // A booking's primary field is its time: a timestamp is never a title.
    const lead = text(roles.title);
    parts.title =
      text(roles.eventName) ?? (lead && !ISO.test(lead) ? lead : field('what', 'service'));
    // A template with one seat input has no section, row and number: the text is the seat.
    const loose = Object.keys(seat).length ? undefined : field('seat');
    if (loose) seat.seat = loose;
    if (Object.keys(seat).length) parts.seat = seat;
    for (const [label, key] of [
      ['Section', 'section'],
      ['Row', 'row'],
      ['Seat', 'seat'],
    ] as const)
      if (seat[key]) parts.facts.push({ label, text: seat[key] });
  } else if (c.kind === 'membership') {
    parts.title = holder ?? text(roles.title);
    parts.type = text(roles.tier) ?? field('membership', 'plan', 'tier', 'role');
    parts.venue = field('homeClub', 'club', 'unit') ?? parts.venue;
    delete parts.address;
  } else if (c.kind === 'permit') {
    const zone = field('zone')?.replace(/^zone\s+/i, '');
    parts.type = field('type');
    parts.title = parts.type;
    parts.hero = {
      ...(zone ? { zone } : {}),
      ...(c.publicLookup ? { plate: c.publicLookup } : {}),
    };
    const bay = field('bay');
    if (bay) parts.facts.push({ label: 'Bay', text: bay });
  } else if (c.kind === 'coupon') {
    const offer = text(roles.offerTitle) ?? field('offer');
    parts.title = offer;
    parts.hero = {
      ...(offer ? { offer } : {}),
      ...((text(roles.offerDetails) ?? field('terms'))
        ? { offerNote: (text(roles.offerDetails) ?? field('terms')) as string }
        : {}),
    };
  } else {
    parts.title = holder;
    parts.hero = holder ? { name: holder } : {};
    const counter = field('code');
    if (counter) parts.facts.push({ label: 'Counter code', text: counter });
    const items = (field('items') ?? '')
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (items.length) {
      parts.items = items;
      parts.facts.push({ label: 'Items', text: String(items.length) });
    }
    const bay = field('bay');
    if (bay) parts.room = bay;
  }
  if (parts.title === undefined) delete parts.title;
  return parts;
}
