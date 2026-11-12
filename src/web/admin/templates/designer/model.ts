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
}

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

export function styleOf(pass: Dict): PassStyle {
  return PASS_STYLES.find((s) => isRecord(pass[s])) ?? 'generic';
}

export function dictOf(pass: Dict): Dict {
  const dict = pass[styleOf(pass)];
  return isRecord(dict) ? dict : {};
}

export function fieldsOf(pass: Dict, group: GroupId): Dict[] {
  const list = dictOf(pass)[group];
  return Array.isArray(list) ? list.filter(isRecord) : [];
}

export const keyOf = (field: Dict): string => String(field.key ?? '');

/** Where a key lives, or null. */
export function findField(pass: Dict, key: string): { group: GroupId; index: number } | null {
  for (const group of groupsFor(styleOf(pass))) {
    const index = fieldsOf(pass, group).findIndex((f) => keyOf(f) === key);
    if (index >= 0) return { group, index };
  }
  return null;
}

export function allKeys(pass: Dict): string[] {
  return groupsFor(styleOf(pass)).flatMap((g) => fieldsOf(pass, g).map(keyOf));
}

export { SLOT_LABEL } from '../../passes/detail/image-slots.ts';

/** Image slots the style draws, in a stable order; icon first. */
export const slotsOf = (pass: Dict, assets: readonly DraftAsset[]): string[] =>
  drawnSlots(
    pass,
    assets.some((a) => a.slot === 'artwork'),
  );

export type Section =
  | 'template'
  | 'style'
  | 'colors'
  | 'images'
  | 'inputs'
  | 'barcode'
  | 'relevance'
  | 'none'
  | 'scan-display'
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
  inputs: 'Inputs',
  barcode: 'Barcode',
  relevance: 'Relevance',
  'scan-display': 'Scan screen',
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
