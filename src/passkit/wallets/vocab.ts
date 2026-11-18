/**
 * The closed vocabularies of the cross-wallet core: roles, targets, art slots, field groups,
 * barcode kinds, capability ids and support levels. A leaf module: the `wallets` manifest schema
 * imports it, so it imports nothing.
 */

/** Facts a target has a native slot for (architecture 2.2). */
export const WALLET_ROLES = [
  'title',
  'subtitle',
  'eventName',
  'eventStart',
  'eventEnd',
  'doorsOpen',
  'venueName',
  'venueAddress',
  'venueLocation',
  'seat',
  'row',
  'section',
  'gate',
  'ticketHolder',
  'ticketNumber',
  'confirmationCode',
  'eventId',
  'memberId',
  'memberName',
  'tier',
  'points',
  'pointsLabel',
  'balance',
  'giftCardNumber',
  'giftCardPin',
  'offerTitle',
  'offerDetails',
  'finePrint',
  'redemptionChannel',
  'validFrom',
  'validUntil',
  'appLink',
  'support',
] as const;
export type WalletRole = (typeof WALLET_ROLES)[number];

export const WALLET_TARGETS = ['google', 'samsung'] as const;
export type WalletTarget = (typeof WALLET_TARGETS)[number];

/** Per-wallet art slots a `wallets.<target>.images` entry can fill (architecture 2.4). */
export const GOOGLE_IMAGE_SLOTS = ['logo', 'hero', 'thumbnail'] as const;
export const SAMSUNG_IMAGE_SLOTS = ['logo', 'main', 'background'] as const;
export type GoogleImageSlot = (typeof GOOGLE_IMAGE_SLOTS)[number];
export type SamsungImageSlot = (typeof SAMSUNG_IMAGE_SLOTS)[number];

/** Field groups in front-to-back order (architecture 3.3 step 2). */
export const VIEW_GROUPS = [
  'header',
  'primary',
  'secondary',
  'auxiliary',
  'additionalInfo',
  'footer',
  'back',
] as const;
export type ViewGroup = (typeof VIEW_GROUPS)[number];

export const BARCODE_KINDS = [
  'qr',
  'pdf417',
  'aztec',
  'code128',
  'code39',
  'codabar',
  'ean13',
  'i2of5',
] as const;
export type BarcodeKind = (typeof BARCODE_KINDS)[number];

const FIELD_CAPABILITIES = VIEW_GROUPS.map((g) => `field.${g}`) as `field.${ViewGroup}`[];
const ROLE_CAPABILITIES = WALLET_ROLES.map((r) => `role.${r}`) as `role.${WalletRole}`[];
const BARCODE_CAPABILITIES = BARCODE_KINDS.map(
  (k) => `barcode.format.${k}`,
) as `barcode.format.${BarcodeKind}`[];

/**
 * Stable capability ids: what `wallets.required` and `<target>.omit` name, what a compiler
 * declares support for and what a fidelity item points at. A parent id (`barcode.format`) stands
 * for its children when used in `required`.
 */
export const CAPABILITY_IDS = [
  'type',
  ...FIELD_CAPABILITIES,
  'field.link',
  'barcode.format',
  ...BARCODE_CAPABILITIES,
  'barcode.altText',
  'colors.background',
  'colors.foreground',
  'colors.label',
  'image.logo',
  'image.icon',
  'image.strip',
  'image.artwork',
  'image.background',
  'image.thumbnail',
  'image.personal',
  'relevance.dates',
  'relevance.locations',
  'relevance.beacons',
  'relevance.maxDistance',
  'validity.expiration',
  'void.visual',
  'messaging.notify',
  'updates.push',
  'upcoming.multi',
  'links.featured',
  'localization.strings',
  'localization.images',
  'sharing',
  'nfc',
  'personalization',
  'text.length',
  ...ROLE_CAPABILITIES,
] as const;
export type CapabilityId = (typeof CAPABILITY_IDS)[number];

/** How a target carries a capability (architecture 4.1). */
export const SUPPORT_LEVELS = ['native', 'text', 'difference', 'omitted', 'unsupported'] as const;
export type Support = (typeof SUPPORT_LEVELS)[number];
