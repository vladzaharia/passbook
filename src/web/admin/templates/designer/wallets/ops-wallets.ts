/**
 * Edits of `manifest.wallets` and the art under `wallets/<target>/`. Every op normalizes, so a
 * template the tab never touches keeps no `wallets` key and its version hash (D9). Rules live in
 * `passkit/template/wallets`; nothing here decides what is valid.
 */
import {
  WALLET_ROLES,
  WALLETS_SCHEMA,
  type WalletRole,
  type WalletRoleSource,
  type WalletTarget,
} from '@/passkit/template/wallets/schema.ts';
import { type DesignDoc, type Dict, type DraftAsset, isRecord } from '../model.ts';

export type WalletsOp =
  | { op: 'wallets-role'; role: WalletRole; source: WalletRoleSource | null }
  | { op: 'wallets-roles'; sources: Partial<Record<WalletRole, WalletRoleSource>> }
  | { op: 'wallets-type'; target: WalletTarget; type: string | null }
  | { op: 'wallets-class-key'; expr: string | null }
  | { op: 'wallets-subtype'; subType: string | null }
  | { op: 'wallets-omit'; target: WalletTarget; entry: string; on: boolean }
  | { op: 'wallets-required'; id: string; on: boolean }
  | { op: 'wallets-image'; target: WalletTarget; slot: string; asset: DraftAsset | null };

export const WALLETS_OPS = [
  'wallets-role',
  'wallets-roles',
  'wallets-type',
  'wallets-class-key',
  'wallets-subtype',
  'wallets-omit',
  'wallets-required',
  'wallets-image',
] as const;

export const artPath = (target: WalletTarget, slot: string): string =>
  `wallets/${target}/${slot}.png`;

export const readWallets = (doc: DesignDoc): Dict =>
  isRecord(doc.manifest.wallets) ? doc.manifest.wallets : {};

const sortedUnique = (list: unknown): string[] =>
  Array.isArray(list) ? [...new Set(list.map(String))].sort() : [];

function cleanTarget(value: unknown): Dict | undefined {
  if (!isRecord(value)) return undefined;
  const out: Dict = {};
  if (value.type !== undefined) out.type = value.type;
  const omit = sortedUnique(value.omit);
  if (omit.length > 0) out.omit = omit;
  if (isRecord(value.images) && Object.keys(value.images).length > 0)
    out.images = Object.fromEntries(
      Object.entries(value.images).sort(([a], [b]) => (a < b ? -1 : 1)),
    );
  if (value.classKey !== undefined) out.classKey = value.classKey;
  if (value.subType !== undefined) out.subType = value.subType;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The block without empty parts; undefined when only the schema is left. */
export function normalizeWallets(block: Dict): Dict | undefined {
  const out: Dict = {};
  const roles = isRecord(block.roles)
    ? WALLET_ROLES.filter((r) => block.roles && (block.roles as Dict)[r] !== undefined)
    : [];
  const required = sortedUnique(block.required);
  const google = cleanTarget(block.google);
  const samsung = cleanTarget(block.samsung);
  if (roles.length > 0)
    out.roles = Object.fromEntries(roles.map((r) => [r, (block.roles as Dict)[r]]));
  if (required.length > 0) out.required = required;
  if (google) out.google = google;
  if (samsung) out.samsung = samsung;
  if (Object.keys(out).length === 0) return undefined;
  return { schema: WALLETS_SCHEMA, ...out };
}

function withWallets(doc: DesignDoc, change: (block: Dict) => Dict): DesignDoc {
  const next = normalizeWallets(change(structuredClone(readWallets(doc))));
  const { wallets: _, ...rest } = doc.manifest;
  const manifest = next ? { ...rest, wallets: next } : rest;
  return JSON.stringify(manifest) === JSON.stringify(doc.manifest) ? doc : { ...doc, manifest };
}

const targetOf = (block: Dict, target: WalletTarget): Dict =>
  isRecord(block[target]) ? (block[target] as Dict) : {};

function setRoles(
  block: Dict,
  sources: Partial<Record<WalletRole, WalletRoleSource | null>>,
): Dict {
  const roles: Dict = isRecord(block.roles) ? { ...block.roles } : {};
  for (const [role, source] of Object.entries(sources)) {
    if (source === null || source === undefined) delete roles[role];
    else roles[role] = source;
  }
  return { ...block, roles };
}

function setImage(doc: DesignDoc, o: Extract<WalletsOp, { op: 'wallets-image' }>): DesignDoc {
  const file = artPath(o.target, o.slot);
  const rest = doc.assets.filter((a) => a.name !== file);
  const assets = o.asset ? [...rest, { ...o.asset, name: file }] : rest;
  const next = withWallets({ ...doc, assets }, (block) => {
    const target = { ...targetOf(block, o.target) };
    const images: Dict = isRecord(target.images) ? { ...target.images } : {};
    if (o.asset) images[o.slot] = file;
    else delete images[o.slot];
    return { ...block, [o.target]: { ...target, images } };
  });
  return !o.asset && assets.length === doc.assets.length && next.manifest === doc.manifest
    ? doc
    : next;
}

export function applyWalletsOp(doc: DesignDoc, o: WalletsOp): DesignDoc {
  switch (o.op) {
    case 'wallets-role':
      return withWallets(doc, (b) => setRoles(b, { [o.role]: o.source }));
    case 'wallets-roles':
      return withWallets(doc, (b) => setRoles(b, o.sources));
    case 'wallets-type':
      return withWallets(doc, (b) => {
        const target = { ...targetOf(b, o.target) };
        if (o.type === null) delete target.type;
        else target.type = o.type;
        return { ...b, [o.target]: target };
      });
    case 'wallets-class-key':
      return withWallets(doc, (b) => {
        const google = { ...targetOf(b, 'google') };
        if (o.expr === null) delete google.classKey;
        else google.classKey = o.expr;
        return { ...b, google };
      });
    case 'wallets-subtype':
      return withWallets(doc, (b) => {
        const samsung = { ...targetOf(b, 'samsung') };
        if (o.subType === null) delete samsung.subType;
        else samsung.subType = o.subType;
        return { ...b, samsung };
      });
    case 'wallets-omit':
      return withWallets(doc, (b) => {
        const target = { ...targetOf(b, o.target) };
        const list = new Set(sortedUnique(target.omit));
        if (o.on) list.add(o.entry);
        else list.delete(o.entry);
        return { ...b, [o.target]: { ...target, omit: [...list] } };
      });
    case 'wallets-required':
      return withWallets(doc, (b) => {
        const list = new Set(sortedUnique(b.required));
        if (o.on) list.add(o.id);
        else list.delete(o.id);
        return { ...b, required: [...list] };
      });
    case 'wallets-image':
      return setImage(doc, o);
  }
}
