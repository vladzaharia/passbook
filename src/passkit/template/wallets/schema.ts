/**
 * The optional `wallets` block of `wallet.template.json` (cross-wallet architecture 2.3). Strict
 * zod, shape only: expressions, field keys and art files are checked in `validate.ts`. Apple output
 * never reads this block.
 */
import { z } from 'zod';

export const WALLETS_SCHEMA = 1;

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

export const GOOGLE_TYPES = ['generic', 'event', 'loyalty', 'gift', 'offer'] as const;
export const SAMSUNG_TYPES = ['loyalty', 'ticket', 'coupon', 'generic', 'giftcard'] as const;
export const SAMSUNG_SUBTYPES = [
  'others',
  'performances',
  'sports',
  'movies',
  'entrances',
] as const;

export const MAX_WALLET_LIST = 50;
export const MAX_WALLET_EXPR = 500;
const MAX_ID = 64;
/** Field keys and capability ids: `backFields.terms`, `barcode.format`, `type`. */
const REFERENCE = /^[A-Za-z][A-Za-z0-9_.-]*$/;
/** Art for one target: `wallets/<target>/<name>.png`, one level deep. */
/** Folder of per-wallet art. Files under it are never signed into a pass or hashed for Apple. */
export const WALLET_ART_DIR = 'wallets/';
export const isWalletArtName = (name: string): boolean => name.startsWith(WALLET_ART_DIR);
export const WALLET_ART = /^wallets\/(google|samsung)\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.png$/;

const reference = z.string().min(1).max(MAX_ID).regex(REFERENCE);
const unique = (list: string[]) => new Set(list).size === list.length;
const references = z.array(reference).max(MAX_WALLET_LIST).refine(unique, 'duplicate');
const expr = z.union([z.string().min(1).max(MAX_WALLET_EXPR), z.strictObject({ const: z.json() })]);

const RoleSource = z.union([
  z.literal(false),
  z.strictObject({ field: reference }),
  z.strictObject({ value: expr }),
]);

const images = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,23}$/), z.string().max(128));

const target = <T extends readonly [string, ...string[]]>(types: T) => ({
  type: z.enum([...types, 'off']).optional(),
  omit: references.optional(),
  images: images.optional(),
});

const GoogleSchema = z.strictObject({ ...target(GOOGLE_TYPES), classKey: expr.optional() });
const SamsungSchema = z.strictObject({
  ...target(SAMSUNG_TYPES),
  subType: z.enum(SAMSUNG_SUBTYPES).optional(),
});

export const WalletsManifestSchema = z.strictObject({
  schema: z.literal(WALLETS_SCHEMA),
  roles: z.partialRecord(z.enum(WALLET_ROLES), RoleSource).optional(),
  required: references.optional(),
  google: GoogleSchema.optional(),
  samsung: SamsungSchema.optional(),
});

export type WalletsManifest = z.infer<typeof WalletsManifestSchema>;
export type WalletRoleSource = z.infer<typeof RoleSource>;
