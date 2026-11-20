import { formatCount, formatExpiry, formatMoney } from '../../lib/format.ts';

/** What a Google card draws, read off the compiled class and object bodies. */
export interface GoogleModel {
  kind: string;
  /** Hex colour of the card; Google picks readable text on it. */
  bg: string | undefined;
  logo: string | undefined;
  /** The line beside the logo: issuer, programme or card title. */
  issuer: string;
  /** The small line above the heading. */
  subheader: string | undefined;
  heading: string;
  facts: { label: string; value: string }[];
  barcode: { bcid: string; message: string; alt: string | undefined } | undefined;
  hero: string | undefined;
  modules: { header: string | undefined; body: string }[];
  links: { description: string; uri: string }[];
  images: string[];
  messages: { header: string; body: string }[];
  state: string;
}

type Dict = Record<string, unknown>;
const dict = (v: unknown): Dict => (v && typeof v === 'object' ? (v as Dict) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
/** A localized string, or a plain one. */
const text = (v: unknown): string | undefined => str(v) ?? str(dict(dict(v).defaultValue).value);
const image = (v: unknown): string | undefined => str(dict(dict(v).sourceUri).uri);

const KINDS: Record<string, string> = {
  generic: 'Generic',
  event: 'Event ticket',
  loyalty: 'Loyalty',
  gift: 'Gift card',
  offer: 'Offer',
};
const BARCODES: Record<string, string> = {
  QR_CODE: 'qrcode',
  PDF_417: 'pdf417',
  AZTEC: 'azteccode',
  CODE_128: 'code128',
  CODE_39: 'code39',
  CODABAR: 'rationalizedCodabar',
  EAN_13: 'ean13',
  ITF_14: 'interleaved2of5',
};

function money(v: unknown): string | undefined {
  const m = dict(v);
  const micros = Number(m.micros);
  const currency = str(m.currencyCode);
  return Number.isFinite(micros) && currency ? formatMoney(micros / 1e6, currency) : undefined;
}

function points(v: unknown): string | undefined {
  const p = dict(v);
  const b = dict(p.balance);
  const value =
    typeof b.int === 'number'
      ? formatCount(b.int)
      : typeof b.double === 'number'
        ? formatCount(b.double)
        : (str(b.string) ?? money(b.money));
  return value ? `${value}${str(p.label) ? ` ${str(p.label)}` : ''}` : undefined;
}

type Fact = { label: string; value: string };
const fact = (label: string, value: string | undefined): Fact[] =>
  value ? [{ label, value }] : [];

interface Parts {
  issuer: string;
  heading: string;
  subheader?: string | undefined;
  logo?: string | undefined;
  hero?: string | undefined;
  facts: Fact[];
  extra?: { header: string; body: string }[];
}

function event(c: Dict, o: Dict): Parts {
  const venue = dict(c.venue);
  const seat = dict(o.seatInfo);
  const start = str(dict(c.dateTime).start);
  return {
    issuer: str(c.issuerName) ?? '',
    heading: text(c.eventName) ?? '',
    logo: image(c.logo),
    hero: image(c.heroImage),
    facts: [
      ...fact('Date', start ? formatExpiry(start) : undefined),
      ...fact('Venue', text(venue.name)),
      ...fact('Section', text(seat.section)),
      ...fact('Row', text(seat.row)),
      ...fact('Seat', text(seat.seat)),
      ...fact('Gate', text(seat.gate)),
      ...fact('Ticket holder', str(o.ticketHolderName)),
      ...fact('Ticket number', str(o.ticketNumber)),
      ...fact('Confirmation', str(dict(o.reservationInfo).confirmationCode)),
    ],
  };
}

function loyalty(c: Dict, o: Dict): Parts {
  return {
    issuer: str(c.programName) ?? str(c.issuerName) ?? '',
    heading: points(o.loyaltyPoints) ?? str(o.accountName) ?? '',
    subheader: points(o.loyaltyPoints) ? str(o.accountName) : undefined,
    logo: image(c.programLogo),
    hero: image(c.heroImage),
    facts: [
      ...fact(str(c.accountIdLabel) ?? 'Account', str(o.accountId)),
      ...fact('Secondary', points(o.secondaryLoyaltyPoints)),
    ],
  };
}

function gift(c: Dict, o: Dict): Parts {
  return {
    issuer: str(c.merchantName) ?? '',
    heading: money(o.balance) ?? str(o.cardNumber) ?? '',
    logo: image(c.programLogo),
    hero: image(c.heroImage),
    facts: [
      ...fact(str(c.cardNumberLabel) ?? 'Card number', str(o.cardNumber)),
      ...fact(str(c.pinLabel) ?? 'PIN', str(o.pin)),
    ],
  };
}

function offer(c: Dict): Parts {
  const channel = { ONLINE: 'Online', INSTORE: 'In store', BOTH: 'Online and in store' }[
    String(c.redemptionChannel)
  ];
  return {
    issuer: str(c.provider) ?? str(c.issuerName) ?? '',
    heading: text(c.localizedTitle) ?? str(c.title) ?? '',
    logo: image(c.titleImage),
    hero: image(c.heroImage),
    facts: fact('Redeem', channel),
    extra: [
      ...((text(c.localizedDetails) ?? str(c.details))
        ? [{ header: 'Details', body: (text(c.localizedDetails) ?? str(c.details)) as string }]
        : []),
      ...((text(c.localizedFinePrint) ?? str(c.finePrint))
        ? [
            {
              header: 'Fine print',
              body: (text(c.localizedFinePrint) ?? str(c.finePrint)) as string,
            },
          ]
        : []),
    ],
  };
}

function generic(o: Dict): Parts {
  return {
    issuer: text(o.cardTitle) ?? '',
    heading: text(o.header) ?? '',
    subheader: text(o.subheader),
    logo: image(o.logo),
    hero: image(o.heroImage),
    facts: [],
  };
}

export function googleModel(type: string, classBody: unknown, objectBody: unknown): GoogleModel {
  const c = dict(classBody);
  const o = dict(objectBody);
  const parts =
    type === 'event'
      ? event(c, o)
      : type === 'loyalty'
        ? loyalty(c, o)
        : type === 'gift'
          ? gift(c, o)
          : type === 'offer'
            ? offer(c)
            : generic(o);
  const code = dict(o.barcode);
  const modules = Array.isArray(o.textModulesData) ? (o.textModulesData as Dict[]) : [];
  const links = dict(o.linksModuleData).uris;
  const images = Array.isArray(o.imageModulesData) ? (o.imageModulesData as Dict[]) : [];
  const messages = Array.isArray(o.messages) ? (o.messages as Dict[]) : [];
  return {
    kind: KINDS[type] ?? type,
    bg: str(o.hexBackgroundColor) ?? str(c.hexBackgroundColor),
    logo: parts.logo ?? image(o.logo),
    issuer: parts.issuer,
    subheader: parts.subheader,
    heading: parts.heading,
    facts: parts.facts,
    barcode:
      str(code.value) && BARCODES[String(code.type)]
        ? {
            bcid: BARCODES[String(code.type)] as string,
            message: code.value as string,
            alt: str(code.alternateText),
          }
        : undefined,
    hero: parts.hero ?? image(o.heroImage),
    modules: [
      ...modules.flatMap((m) =>
        str(m.body)
          ? [{ header: str(m.header) ?? text(m.localizedHeader), body: m.body as string }]
          : [],
      ),
      ...(parts.extra ?? []).map((e) => ({ header: e.header, body: e.body })),
    ],
    links: Array.isArray(links)
      ? (links as Dict[]).flatMap((l) =>
          str(l.uri)
            ? [{ description: str(l.description) ?? (l.uri as string), uri: l.uri as string }]
            : [],
        )
      : [],
    images: images.flatMap((m) => image(m.mainImage) ?? []),
    messages: messages.flatMap((m) =>
      str(m.body) ? [{ header: str(m.header) ?? '', body: m.body as string }] : [],
    ),
    state: str(o.state) ?? 'ACTIVE',
  };
}
