import { PASS_STYLES, type PassStyle } from '@/passkit/types.ts';
import { drawnSlots } from '../../passes/detail/image-slots.ts';

/** The designer edits the two JSON documents of a version as plain data. */
export type Dict = Record<string, unknown>;

/** A file of the version: saved ones carry their hash, new ones their PNG as base64. */
export interface DraftAsset {
  name: string;
  slot: string;
  scale: 1 | 2 | 3;
  size: number;
  width?: number | undefined;
  height?: number | undefined;
  sha1?: string | undefined;
  upload?: string | undefined;
}

export interface DesignDoc {
  passJson: Dict;
  manifest: Dict;
  assets: DraftAsset[];
  /** Which dictionary a pass with both Generic and Poster generic edits; view state, never saved. */
  target?: Target | undefined;
}

/** `poster` is iOS 27 (posterGeneric); `legacy` is iOS 26 and earlier. */
export type Target = 'legacy' | 'poster';

export const STYLE_LABEL: Record<PassStyle, string> = {
  generic: 'Generic',
  posterGeneric: 'Poster generic',
  storeCard: 'Store card',
  coupon: 'Coupon',
  eventTicket: 'Event ticket',
  boardingPass: 'Boarding pass',
};

export type GroupId =
  | 'headerFields'
  | 'primaryFields'
  | 'secondaryFields'
  | 'auxiliaryFields'
  | 'additionalInfoFields'
  | 'footerFields'
  | 'backFields';

export const GROUP_LABEL: Record<GroupId, string> = {
  headerFields: 'Header',
  primaryFields: 'Primary',
  secondaryFields: 'Secondary',
  auxiliaryFields: 'Auxiliary',
  additionalInfoFields: 'Additional info',
  footerFields: 'Footer',
  backFields: 'Back',
};

/** Fields each style draws, front to back. */
export function groupsFor(style: PassStyle): GroupId[] {
  const base: GroupId[] = ['headerFields', 'primaryFields', 'secondaryFields', 'auxiliaryFields'];
  if (style === 'eventTicket' || style === 'posterGeneric') base.push('additionalInfoFields');
  if (style === 'posterGeneric') base.push('footerFields');
  return [...base, 'backFields'];
}

export const isRecord = (v: unknown): v is Dict =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The dictionary being edited; a lone posterGeneric is always it. */
export function styleOf(pass: Dict, target?: Target): PassStyle {
  if (target === 'poster' && isRecord(pass.posterGeneric)) return 'posterGeneric';
  return PASS_STYLES.find((s) => isRecord(pass[s])) ?? 'generic';
}

/** The style the author picked: a poster layout always pairs with Generic. */
export function legacyStyleOf(pass: Dict): PassStyle {
  const s = PASS_STYLES.find((p) => p !== 'posterGeneric' && isRecord(pass[p]));
  return s ?? 'generic';
}

/** Both iOS 27 and legacy layouts exist, so the editor needs a target. */
export const hasBothFaces = (pass: Dict): boolean =>
  isRecord(pass.posterGeneric) &&
  PASS_STYLES.some((s) => s !== 'posterGeneric' && isRecord(pass[s]));

/** With both layouts the Edit layout toggle picks the face the card draws; undefined otherwise. */
export const previewTargetOf = (pass: Dict, target?: Target): 'ios27' | 'legacy' | undefined =>
  hasBothFaces(pass) ? (target === 'poster' ? 'ios27' : 'legacy') : undefined;

export function dictOf(pass: Dict, target?: Target): Dict {
  const dict = pass[styleOf(pass, target)];
  return isRecord(dict) ? dict : {};
}

export function fieldsOf(pass: Dict, group: GroupId, target?: Target): Dict[] {
  const list = dictOf(pass, target)[group];
  return Array.isArray(list) ? list.filter(isRecord) : [];
}

export const keyOf = (field: Dict): string => String(field.key ?? '');

/** Where a key lives, or null. */
export function findField(
  pass: Dict,
  key: string,
  target?: Target,
): { group: GroupId; index: number } | null {
  for (const group of groupsFor(styleOf(pass, target))) {
    const index = fieldsOf(pass, group, target).findIndex((f) => keyOf(f) === key);
    if (index >= 0) return { group, index };
  }
  return null;
}

export function allKeys(pass: Dict, target?: Target): string[] {
  return groupsFor(styleOf(pass, target)).flatMap((g) => fieldsOf(pass, g, target).map(keyOf));
}

/** Keys of every dictionary, so a new key never collides with the other layout. */
export const everyKey = (pass: Dict): string[] => [
  ...allKeys(pass, 'legacy'),
  ...(isRecord(pass.posterGeneric) ? allKeys(pass, 'poster') : []),
];

export { SLOT_LABEL } from '../../passes/detail/image-slots.ts';

/** Image slots the style draws, in a stable order; icon first. */
export const slotsOf = (pass: Dict, assets: readonly DraftAsset[]): string[] =>
  drawnSlots(
    pass,
    assets.some((a) => a.slot === 'artwork'),
  );

/** The Wallets tab's inspector; `key` is a role, a field path or an image slot. */
export type WalletsSection =
  | 'wallets-type'
  | 'wallets-roles'
  | 'wallets-fields'
  | 'wallets-images'
  | 'wallets-required';

export type Section =
  | 'template'
  | 'style'
  | 'colors'
  | 'images'
  | 'stamps'
  | 'counters'
  | 'inputs'
  | 'barcode'
  | 'relevance'
  | 'access'
  | 'scan-actions'
  | 'none'
  | 'scan-display'
  | WalletsSection
  | GroupId;

export interface Selection {
  section: Section;
  /** Field key, input name or slot inside the section. */
  key?: string | undefined;
}

export const SECTION_LABEL: Record<Exclude<Section, GroupId>, string> = {
  none: '',
  template: 'Template',
  style: 'Style',
  colors: 'Colors',
  images: 'Images',
  stamps: 'Stamps',
  counters: 'Counters',
  inputs: 'Inputs',
  barcode: 'Barcode',
  relevance: 'Relevance',
  access: 'Access',
  'scan-actions': 'Scan actions',
  'scan-display': 'Scan screen',
  'wallets-type': 'Type',
  'wallets-roles': 'Roles',
  'wallets-fields': 'Fields',
  'wallets-images': 'Images',
  'wallets-required': 'Required',
};

export const sectionLabel = (s: Section): string =>
  s in GROUP_LABEL
    ? `${GROUP_LABEL[s as GroupId]} fields`
    : SECTION_LABEL[s as keyof typeof SECTION_LABEL];

/** Locations, beacons and relevant dates the pass carries. */
export function listCount(doc: DesignDoc): number {
  return (['locations', 'beacons', 'relevantDates'] as const).reduce((n, k) => {
    const list = doc.passJson[k];
    return n + (Array.isArray(list) ? list.length : 0);
  }, 0);
}
