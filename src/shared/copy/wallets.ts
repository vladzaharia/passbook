/** Words the designer's Wallets tab, the import report and the release review share. */
import type { CapabilityId, ViewGroup, WalletRole } from '../../passkit/wallets/vocab.ts';

export const ROLE_LABEL: Record<WalletRole, string> = {
  title: 'Title',
  subtitle: 'Subtitle',
  eventName: 'Event name',
  eventStart: 'Start time',
  eventEnd: 'End time',
  doorsOpen: 'Doors open',
  venueName: 'Venue',
  venueAddress: 'Venue address',
  venueLocation: 'Venue location',
  seat: 'Seat',
  row: 'Row',
  section: 'Section',
  gate: 'Gate',
  ticketHolder: 'Ticket holder',
  ticketNumber: 'Ticket number',
  confirmationCode: 'Confirmation code',
  eventId: 'Event ID',
  memberId: 'Member ID',
  memberName: 'Member name',
  tier: 'Tier',
  points: 'Points',
  pointsLabel: 'Points label',
  balance: 'Balance',
  giftCardNumber: 'Card number',
  giftCardPin: 'Card PIN',
  offerTitle: 'Offer title',
  offerDetails: 'Offer details',
  finePrint: 'Terms',
  redemptionChannel: 'Redeem',
  validFrom: 'Valid from',
  validUntil: 'Valid until',
  appLink: 'App link',
  support: 'Support',
};

export const GROUP_NAME: Record<ViewGroup, string> = {
  header: 'Header',
  primary: 'Primary',
  secondary: 'Secondary',
  auxiliary: 'Auxiliary',
  additionalInfo: 'Additional info',
  footer: 'Footer',
  back: 'Back',
};

const CAPABILITY_NAMES: Partial<Record<CapabilityId, string>> = {
  type: 'Wallet type',
  'field.link': 'Field links',
  'barcode.format': 'Barcode format',
  'barcode.altText': 'Barcode text',
  'colors.background': 'Background colour',
  'colors.foreground': 'Text colour',
  'colors.label': 'Label colour',
  'image.logo': 'Logo',
  'image.icon': 'Icon',
  'image.strip': 'Strip image',
  'image.artwork': 'Artwork',
  'image.background': 'Background image',
  'image.thumbnail': 'Thumbnail',
  'image.personal': 'Member photo',
  'relevance.dates': 'Relevant dates',
  'relevance.locations': 'Locations',
  'relevance.beacons': 'Beacons',
  'relevance.maxDistance': 'Location distance',
  'validity.expiration': 'Expiry',
  'void.visual': 'Voided look',
  'messaging.notify': 'Change messages',
  'updates.push': 'Updates',
  'upcoming.multi': 'Upcoming events',
  'links.featured': 'Featured actions',
  'localization.strings': 'Translations',
  'localization.images': 'Localized images',
  sharing: 'Sharing',
  nfc: 'NFC',
  personalization: 'Personalization',
  'text.length': 'Text length',
};

const BARCODE_KIND_LABEL: Record<string, string> = {
  qr: 'QR',
  pdf417: 'PDF417',
  aztec: 'Aztec',
  code128: 'Code 128',
  code39: 'Code 39',
  codabar: 'Codabar',
  ean13: 'EAN-13',
  i2of5: 'Interleaved 2 of 5',
};

/** What an author calls a capability id (`wallets.required`, `omit` and report items). */
export function capabilityLabel(id: string): string {
  const named = CAPABILITY_NAMES[id as CapabilityId];
  if (named) return named;
  if (id.startsWith('role.')) return ROLE_LABEL[id.slice(5) as WalletRole] ?? id.slice(5);
  if (id.startsWith('barcode.format.'))
    return `${BARCODE_KIND_LABEL[id.slice(15)] ?? id.slice(15)} barcode`;
  if (id.startsWith('field.'))
    return `${GROUP_NAME[id.slice(6) as ViewGroup] ?? id.slice(6)} fields`;
  return id;
}

export const TYPE_LABEL = {
  google: {
    generic: 'Generic',
    event: 'Event ticket',
    loyalty: 'Loyalty',
    gift: 'Gift card',
    offer: 'Offer',
  },
  samsung: {
    loyalty: 'Loyalty',
    ticket: 'Ticket',
    coupon: 'Coupon',
    generic: 'Generic',
    giftcard: 'Gift card',
  },
} as const;

export const typeLabel = (target: 'google' | 'samsung', type: string): string =>
  (TYPE_LABEL[target] as Record<string, string>)[type] ?? type;

export const SHORT_NAME = { google: 'Google', samsung: 'Samsung' } as const;

export const SUBTYPE_LABEL = {
  others: 'Others',
  performances: 'Performance',
  sports: 'Sports',
  movies: 'Movie',
  entrances: 'Entry',
} as const;

export const SLOT_NAME: Record<string, string> = {
  logo: 'Logo',
  hero: 'Hero',
  thumbnail: 'Thumbnail',
  main: 'Main image',
  background: 'Background',
};

export const WALLETS_COPY = {
  mode: 'Wallets',
  rail: 'Wallet',
  source: 'Source',
  automatic: 'Automatic',
  setHere: 'Set here',
  offTemplate: 'Off for this template.',
  offPackage: 'Off in the package.',
  useAutomaticType: 'Use automatic type',
  changeInChannels: 'Change it in Channels and brand.',
  sections: {
    type: '{short} type',
    roles: 'Roles',
    fields: '{short} fields',
    images: '{short} images',
    required: 'Required',
  },
  type: {
    fits: 'Own slots: {slots}',
    needs: 'Needs {needs}',
    autoPicks: 'Automatic picks this',
    asLoyalty: 'Shown as loyalty for now.',
    googleClass: 'Google class',
    classOne: 'One for the template',
    classHelp: 'Passes with the same value share event details.',
    ticketKind: 'Ticket kind',
  },
  roles: {
    own: 'Own slots on {wallet} {type}',
    text: 'Written as text on {wallet}',
    notSet: 'Not set ({n})',
    accept: 'Accept {n}',
    use: 'Use',
    suggested: 'Suggested: {field}',
    twice: 'Shows twice: also {role}.',
    semantics: 'Apple semantics',
    style: 'Style default',
    set: 'Set here',
    auto: 'Auto',
    notSetValue: 'Not set',
    empty: 'Empty',
    automaticMenu: 'Automatic',
    valueItem: 'Value…',
    leaveEmpty: 'Leave empty',
    requiredEvery: 'Required on every wallet',
    valueLabel: 'Value',
    valuePlaceholder: '{{tier}}',
  },
  fields: {
    ownSlot: 'Own slot: {role}',
    text: 'Text',
    notice: 'Notice',
    notShown: 'Not shown',
    leftOut: 'Left out by you',
    show: 'Show {label} on {wallet}',
    edit: 'Edit field',
    none: 'No fields.',
  },
  images: {
    from: 'From {file}',
    cut: 'From {file}, cut to {size}.',
    none: 'No art.',
    add: 'Add PNG',
    replace: 'Replace',
    remove: 'Remove',
    min: '{w} × {h} or larger',
    square: 'square',
    wide: '{w} wide or more',
    exact: '{w} × {h}',
    under: 'under {kb} KB',
  },
  required: {
    add: 'Require…',
    help: "A wallet that can't carry one is blocked.",
    none: 'Nothing required.',
    remove: 'Stop requiring {label}',
  },
  report: {
    approved: 'Each is approved at release.',
    notShown: 'Not shown',
    different: 'Shown differently',
    notIn: 'Not in {wallet}',
    holders: 'Holders notice',
    door: 'Staff at the door notice',
    goTo: 'Go to {label}',
    leaveOut: 'Leave out on purpose',
    showAgain: 'Show again',
    requireEvery: 'Require on every wallet',
    noPreview: 'No preview while blocked.',
    dontRequire: "Don't require {label}",
    setClass: 'Set Google class',
    issuesInPass: '{n} issues in Pass',
    sample: 'Sample values. Each pass shows its own.',
    editInWallets: 'Edit in Wallets',
    editInDesigner: 'Edit in designer',
    live: '{wallet}: {status}',
    blockedTitle: '{wallet} cannot show this pass.',
  },
  preview: { approximate: 'Preview', compare: 'Apple', compareLabel: 'Compare with Apple' },
} as const;
