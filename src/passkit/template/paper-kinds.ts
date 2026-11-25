/**
 * Per-class reading of a pass for paper: which facts lead on the door panel and the holder panel.
 * `kindOf` derives the class when the paper block has none; `kindContent` reads the facts, only
 * through the guarded `field` reader so no credential or lookup value can reach the sheet.
 */
import type { PassStyle, TemplateManifest } from '../types.ts';
import type { ResolvedRoles } from '../wallets/types.ts';
import type { PaperKind } from './paper.ts';
import { ISO, iso, type Kinded, type KindParts, str, text, when } from './paper-kinds-base.ts';
import { idParts } from './paper-kinds-id.ts';
import { tripParts } from './paper-kinds-trip.ts';

export { type Info, type InfoKey, ISO, type Kinded, type KindParts } from './paper-kinds-base.ts';

/** The field keys a template binds: what its pass carries, known without building a pass. */
export function boundKeys(manifest: { bindings?: TemplateManifest['bindings'] }): Set<string> {
  const keys = new Set<string>();
  for (const b of Array.isArray(manifest.bindings) ? manifest.bindings : []) {
    const field = (b.to as { field?: unknown } | undefined)?.field;
    for (const key of Array.isArray(field) ? field : [field])
      if (typeof key === 'string') keys.add(key);
  }
  return keys;
}

/** A title is never a timestamp. */
const named = (v: string | undefined) => (v && !ISO.test(v) ? v : undefined);

/**
 * The class when the paper block names none. Reads the template (group, scan, bound field keys) and
 * the pass style, so a staff check of "is this an ID" needs no built pass.
 */
export function kindOf(
  manifest: {
    display?: unknown;
    scan?: unknown;
    bindings?: TemplateManifest['bindings'];
  },
  style: PassStyle | undefined,
  roles: ResolvedRoles,
): PaperKind {
  if (style === 'coupon') return 'coupon';
  const keys = boundKeys(manifest);
  const group = (manifest.display as { group?: string } | undefined)?.group;
  const scan = manifest.scan as { window?: unknown; display?: { photo?: unknown } } | undefined;
  if (group === 'prove-collect' && keys.has('credential')) return 'credential';
  if (style === 'boardingPass' || (keys.has('origin') && keys.has('destination'))) return 'journey';
  if (keys.has('in') && keys.has('out')) return 'stay';
  if (keys.has('what') && (keys.has('when') || keys.has('with'))) return 'booking';
  if (style === 'eventTicket' || roles.eventStart) return 'admission';
  if (group === 'prove-collect') return scan?.window ? 'permit' : 'pickup';
  if (group === 'get-in' && scan?.display?.photo) return 'badge';
  if (style === 'storeCard' || group === 'membership-id' || roles.memberName) return 'membership';
  return 'admission';
}

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
    field('attendee', 'holder', 'passenger', 'memberName', 'name') ??
    (c.kind === 'permit' || (c.kind === 'coupon' && !field('pack')) ? undefined : c.holderName);
  const start =
    when(c, roles.eventStart, 'date', 'time') ??
    c.declared?.start ??
    when(c, undefined, 'departs', 'in', 'when');
  // An event's own start is its validity; a template's start input leaves its validity alone.
  const timed =
    c.kind === 'admission'
      ? Boolean(iso(roles.eventStart))
      : ['journey', 'booking', 'stay'].includes(c.kind) && Boolean(start);
  const parts: KindParts = {
    start,
    end:
      c.kind === 'journey'
        ? undefined
        : (iso(roles.eventEnd) ?? c.declared?.end ?? when(c, undefined, 'out')),
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
    info: {},
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
    parts.title = named(text(roles.eventName)) ?? named(lead) ?? field('what', 'service');
    // A template with one seat input has no section, row and number: the text is the seat.
    const loose = Object.keys(seat).length ? undefined : field('seat');
    if (loose) seat.seat = loose;
    if (Object.keys(seat).length) parts.seat = seat;
    // The party size and the gate are what the door counts and points to; a bare room is named.
    const party = field('party');
    if (party) parts.info.party = party;
    const gate = field('gate')?.replace(/^gate\s+/i, '');
    if (gate) parts.info.gate = gate;
    const entrance = !semantics.venueRoom ? c.meta('room', 'entrance') : undefined;
    if (entrance?.label && !entrance.text.toLowerCase().includes(entrance.label.toLowerCase()))
      parts.room = `${entrance.label} ${entrance.text}`;
    for (const [label, key] of [
      ['Section', 'section'],
      ['Row', 'row'],
      ['Seat', 'seat'],
    ] as const)
      if (seat[key]) parts.facts.push({ label, text: seat[key] });
    if (party && !parts.facts.length) parts.facts.push({ label: 'Party', text: party });
  } else if (c.kind === 'journey' || c.kind === 'booking' || c.kind === 'stay') {
    tripParts(c, parts, seat);
  } else if (c.kind === 'badge' || c.kind === 'credential') {
    idParts(c, parts);
  } else if (c.kind === 'membership') {
    parts.title = holder ?? named(text(roles.title));
    const tier = c.meta('membership', 'plan', 'tier', 'role');
    parts.type = text(roles.tier) ?? tier?.text;
    if (tier?.label) parts.info.typeLabel = tier.label;
    const club = c.meta('homeClub', 'club', 'unit');
    parts.venue = club?.text ?? parts.venue;
    if (club?.label) parts.info.venueLabel = club.label;
    delete parts.address;
    loyalty(c, parts);
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
    // A pack prints what it was sold as; the uses left change with every visit and never print.
    const pack = field('pack');
    const offer = pack ? `Pack of ${pack}` : (text(roles.offerTitle) ?? field('offer'));
    parts.title = offer;
    parts.hero = {
      ...(offer ? { offer } : {}),
      ...(!pack && (text(roles.offerDetails) ?? field('terms'))
        ? { offerNote: (text(roles.offerDetails) ?? field('terms')) as string }
        : {}),
    };
    if (pack) parts.info.pack = 'true';
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

/** A stamp or reward card prints its reward and goal; the count of stamps taken is live and never prints. */
function loyalty(c: Kinded, parts: KindParts): void {
  const reward = c.field('reward');
  if (!reward) return;
  const goal = /\b(?:of|\/)\s*(\d+)\b/.exec(c.field('stamps') ?? '')?.[1];
  parts.info.reward = reward;
  if (goal) parts.info.goal = goal;
  parts.type = goal ? `${goal} stamps = ${reward}` : reward;
  parts.info.typeLabel = 'Reward';
}
