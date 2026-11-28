/**
 * Steps 2 and 3 of role resolution (architecture 2.2): the Apple `semantics` tags a role reads and
 * the style defaults, one entry per row of the table. Step 1 (the manifest) is in `roles.ts`.
 */
import type { PassLocation, PassStyle, SemanticTags } from '../types.ts';
import type { RoleScalar, ViewBarcode, ViewField, ViewLink, WalletRole } from './types.ts';

export interface RoleInput {
  style: PassStyle;
  org: string;
  fields: readonly ViewField[];
  /** Root `semantics` of pass.json. */
  semantics?: SemanticTags;
  barcodes: readonly ViewBarcode[];
  /** The start and end the template's own inputs name (paper's resolver). */
  declared?: { start?: string; end?: string };
  locations: readonly PassLocation[];
  expirationDate?: string;
  /** The organization's logo, name and website, from settings. Never a `/p` capability URL. */
  appLink?: { name?: string; url?: string; logo?: string };
}

export interface Hit {
  scalar: RoleScalar;
  label?: string;
  /** Paths of the fields that supplied the value. */
  fields: string[];
}
export type Rule = {
  semantic?: (input: RoleInput) => Hit | undefined;
  style?: (input: RoleInput) => Hit | undefined;
};

const clean = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
const text = (value: string, from?: ViewField): Hit => ({
  scalar: { kind: 'text', text: value },
  ...(from?.label ? { label: from.label } : {}),
  fields: from ? [from.path] : [],
});
const dateHit = (iso: string, from?: ViewField): Hit => ({
  ...text(iso, from),
  scalar: { kind: 'date', iso },
});

interface Tagged {
  value: unknown;
  field?: ViewField;
}

/** Everything that carries `tag`: the pass first, then fields front to back. */
function tagged(input: RoleInput, tag: string): Tagged[] {
  const out: Tagged[] = [];
  const root = (input.semantics as Record<string, unknown> | undefined)?.[tag];
  if (root !== undefined) out.push({ value: root });
  for (const field of input.fields) {
    const value = (field.semantics as Record<string, unknown> | undefined)?.[tag];
    if (value !== undefined) out.push({ value, field });
  }
  return out;
}

/** First string value among `tags`, in tag order. */
const textOf =
  (...tags: string[]) =>
  (input: RoleInput): Hit | undefined => {
    for (const tag of tags)
      for (const { value, field } of tagged(input, tag)) {
        const found = clean(value);
        if (found) return text(found, field);
      }
    return undefined;
  };

const dateOf =
  (...tags: string[]) =>
  (input: RoleInput): Hit | undefined => {
    for (const tag of tags)
      for (const { value, field } of tagged(input, tag)) {
        const found = clean(
          typeof value === 'object' && value ? (value as { date?: unknown }).date : value,
        );
        if (found && !Number.isNaN(Date.parse(found))) return dateHit(found, field);
      }
    return undefined;
  };

const seatOf =
  (prop: 'seatNumber' | 'seatRow' | 'seatSection') =>
  (input: RoleInput): Hit | undefined => {
    for (const { value, field } of tagged(input, 'seats')) {
      const found = clean((value as { [key: string]: unknown }[] | undefined)?.[0]?.[prop]);
      if (found) return text(found, field);
    }
    return undefined;
  };

function personOf(...tags: string[]) {
  return (input: RoleInput): Hit | undefined => {
    for (const tag of tags)
      for (const { value, field } of tagged(input, tag)) {
        if (typeof value === 'string') {
          const found = clean(value);
          if (found) return text(found, field);
          continue;
        }
        const p = (value ?? {}) as Record<string, unknown>;
        const name = [p.namePrefix, p.givenName, p.middleName, p.familyName, p.nameSuffix]
          .map(clean)
          .filter((part): part is string => part !== undefined)
          .join(' ');
        if (name) return text(name, field);
      }
    return undefined;
  };
}

const inGroup = (input: RoleInput, group: ViewField['group']) =>
  input.fields.filter((f) => f.group === group);

/** A money field's text carries its currency (`25 USD`), as the body modules already show it. */
const withCurrency = (field: ViewField): string => {
  const shown = field.text.trim();
  return field.currencyCode !== undefined && Number.isFinite(Number(shown))
    ? `${shown} ${field.currencyCode}`
    : shown;
};

/** The first field of a group with a value, as text. */
const firstOf =
  (group: ViewField['group'], only?: PassStyle) =>
  (input: RoleInput): Hit | undefined => {
    if (only && input.style !== only) return undefined;
    const field = inGroup(input, group).find((f) => f.text.trim() !== '');
    return field ? text(withCurrency(field), field) : undefined;
  };

function venueAddress(input: RoleInput): Hit | undefined {
  const parts = [textOf('venueRoom')(input), textOf('venueRegionName')(input)].filter(
    (h): h is Hit => h !== undefined,
  );
  if (parts.length === 0) return undefined;
  return {
    scalar: {
      kind: 'text',
      text: parts.map((h) => (h.scalar as { text: string }).text).join(', '),
    },
    fields: parts.flatMap((h) => h.fields),
  };
}

function venueLocation(input: RoleInput): Hit | undefined {
  for (const { value, field } of tagged(input, 'venueLocation')) {
    const p = (value ?? {}) as { latitude?: unknown; longitude?: unknown };
    if (typeof p.latitude === 'number' && typeof p.longitude === 'number')
      return {
        scalar: { kind: 'location', latitude: p.latitude, longitude: p.longitude },
        fields: field ? [field.path] : [],
      };
  }
  return undefined;
}

function balance(input: RoleInput): Hit | undefined {
  for (const { value, field } of tagged(input, 'balance')) {
    const p = (value ?? {}) as { amount?: unknown; currencyCode?: unknown };
    const amount = clean(p.amount);
    const currencyCode = clean(p.currencyCode);
    if (amount && currencyCode)
      return {
        scalar: { kind: 'money', amount, currencyCode },
        ...(field?.label ? { label: field.label } : {}),
        fields: field ? [field.path] : [],
      };
  }
  return undefined;
}

const firstBarcode = (input: RoleInput): ViewBarcode | undefined =>
  input.barcodes.find((b) => clean(b.altText));

function offerDetails(input: RoleInput): Hit | undefined {
  if (input.style !== 'coupon') return undefined;
  const back = inGroup(input, 'back').filter((f) => f.text.trim() !== '');
  if (back.length === 0) return undefined;
  return {
    scalar: { kind: 'text', text: back.map((f) => f.text.trim()).join('\n') },
    fields: back.map((f) => f.path),
  };
}

function support(input: RoleInput): Hit | undefined {
  const links: ViewLink[] = [];
  const fields: string[] = [];
  for (const field of inGroup(input, 'back'))
    for (const link of field.links)
      if (link.kind !== 'other' && !links.some((l) => l.url === link.url)) {
        links.push(link);
        if (!fields.includes(field.path)) fields.push(field.path);
      }
  return links.length > 0 ? { scalar: { kind: 'links', links }, fields } : undefined;
}

const none: Rule = {};

/** One entry per row of the architecture 2.2 table. */
export const ROLE_RULES: Record<WalletRole, Rule> = {
  title: { style: firstOf('primary') },
  subtitle: { style: firstOf('secondary') },
  eventName: { semantic: textOf('eventName'), style: firstOf('primary', 'eventTicket') },
  eventStart: {
    semantic: dateOf('eventStartDate', 'eventStartDateInfo'),
    style: (i) => {
      const start = i.declared?.start;
      return start ? dateHit(start) : undefined;
    },
  },
  eventEnd: {
    semantic: dateOf('eventEndDate'),
    style: (i) => {
      const end = i.declared?.end;
      return end ? dateHit(end) : undefined;
    },
  },
  doorsOpen: { semantic: dateOf('venueDoorsOpenDate') },
  venueName: { semantic: textOf('venueName') },
  venueAddress: { semantic: venueAddress },
  venueLocation: {
    semantic: venueLocation,
    style: (i) =>
      i.locations[0]
        ? {
            scalar: {
              kind: 'location',
              latitude: i.locations[0].latitude,
              longitude: i.locations[0].longitude,
            },
            fields: [],
          }
        : undefined,
  },
  seat: { semantic: seatOf('seatNumber') },
  row: { semantic: seatOf('seatRow') },
  section: { semantic: seatOf('seatSection') },
  gate: { semantic: textOf('venueEntranceGate') },
  ticketHolder: { semantic: textOf('attendeeName') },
  ticketNumber: none,
  confirmationCode: { semantic: textOf('confirmationNumber') },
  eventId: none,
  memberId: {
    semantic: textOf('membershipProgramNumber'),
    style: (i) => {
      const alt = i.style === 'storeCard' ? clean(firstBarcode(i)?.altText) : undefined;
      return alt ? text(alt) : undefined;
    },
  },
  memberName: { semantic: personOf('passengerName', 'attendeeName') },
  tier: { semantic: textOf('membershipProgramStatus') },
  points: none,
  pointsLabel: none,
  balance: { semantic: balance },
  giftCardNumber: none,
  giftCardPin: none,
  offerTitle: { style: firstOf('primary', 'coupon') },
  offerDetails: { style: offerDetails },
  finePrint: none,
  redemptionChannel: {
    style: (i) =>
      i.style === 'coupon'
        ? { scalar: { kind: 'channel', channel: 'both' }, fields: [] }
        : undefined,
  },
  validFrom: {
    style: (i) => {
      const start = i.declared?.start;
      return start ? dateHit(start) : undefined;
    },
  },
  validUntil: { style: (i) => (i.expirationDate ? dateHit(i.expirationDate) : undefined) },
  appLink: {
    style: (i) =>
      i.appLink && (i.appLink.name || i.appLink.url || i.appLink.logo)
        ? { scalar: { kind: 'app', ...i.appLink }, fields: [] }
        : undefined,
  },
  support: { style: support },
};
