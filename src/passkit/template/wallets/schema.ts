/**
 * The optional `wallets` block of `wallet.template.json` (cross-wallet architecture 2.3). Strict
 * zod, shape only: expressions, field keys and art files are checked in `validate.ts`. Apple output
 * never reads this block.
 */
import { z } from 'zod';
import {
  CAPABILITY_IDS,
  GOOGLE_IMAGE_SLOTS,
  SAMSUNG_IMAGE_SLOTS,
  VIEW_GROUPS,
  WALLET_ROLES,
  WALLET_TARGETS,
} from '../../wallets/vocab.ts';

export type { WalletRole, WalletTarget } from '../../wallets/vocab.ts';
export { WALLET_ROLES, WALLET_TARGETS };

export const WALLETS_SCHEMA = 1;

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
const BARE_KEY = /^[A-Za-z][A-Za-z0-9_-]*$/;
/** Art for one target: `wallets/<target>/<name>.png`, one level deep. */
/** Folder of per-wallet art. Files under it are never signed into a pass or hashed for Apple. */
export const WALLET_ART_DIR = 'wallets/';
export const isWalletArtName = (name: string): boolean => name.startsWith(WALLET_ART_DIR);
export const WALLET_ART = /^wallets\/(google|samsung)\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.png$/;

const reference = z.string().min(1).max(MAX_ID).regex(REFERENCE);
const unique = (list: string[]) => new Set(list).size === list.length;
const expr = z.union([z.string().min(1).max(MAX_WALLET_EXPR), z.strictObject({ const: z.json() })]);

const RoleSource = z.union([
  z.literal(false),
  z.strictObject({ field: reference }),
  z.strictObject({ value: expr }),
]);

const capability = z.enum(CAPABILITY_IDS);
/** `backFields.terms`: a field of one group, by its dictionary and key. */
const FIELD_PATH = new RegExp(`^(?:${VIEW_GROUPS.join('|')})Fields\\.[A-Za-z][A-Za-z0-9_-]*$`);
/** A field by path or bare key, or a capability id. Compilers match the first two against paths. */
const omission = z.union([capability, z.string().regex(FIELD_PATH), z.string().regex(BARE_KEY)]);
const omissions = z.array(omission).max(MAX_WALLET_LIST).refine(unique, 'duplicate');
const image = z.string().max(128);

const target = <T extends readonly [string, ...string[]]>(types: T) => ({
  type: z.enum([...types, 'off']).optional(),
  omit: omissions.optional(),
});

const GoogleSchema = z.strictObject({
  ...target(GOOGLE_TYPES),
  images: z.partialRecord(z.enum(GOOGLE_IMAGE_SLOTS), image).optional(),
  classKey: expr.optional(),
});
const SamsungSchema = z.strictObject({
  ...target(SAMSUNG_TYPES),
  images: z.partialRecord(z.enum(SAMSUNG_IMAGE_SLOTS), image).optional(),
  subType: z.enum(SAMSUNG_SUBTYPES).optional(),
});

export const WalletsManifestSchema = z.strictObject({
  schema: z.literal(WALLETS_SCHEMA),
  roles: z.partialRecord(z.enum(WALLET_ROLES), RoleSource).optional(),
  required: z.array(capability).max(MAX_WALLET_LIST).refine(unique, 'duplicate').optional(),
  google: GoogleSchema.optional(),
  samsung: SamsungSchema.optional(),
});

export type WalletsManifest = z.infer<typeof WalletsManifestSchema>;
export type WalletRoleSource = z.infer<typeof RoleSource>;
