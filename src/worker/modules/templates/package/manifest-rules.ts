import { isAllowedPointer, parsePointer } from '../../../../passkit/template/pointer.ts';

/**
 * Schema keywords uploaded manifests may use. `pattern` is checked separately (safe regex and a
 * bounded maxLength); no references.
 */
export const ALLOWED_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'enum',
  'const',
  'title',
  'description',
  'default',
  'examples',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'items',
  'additionalProperties',
  'format',
  'oneOf',
  'anyOf',
  'allOf',
  'not',
  'dependentRequired',
  'pattern',
  '$schema',
]);

/** Pass.json roots whose contents are per-pass data. Server-owned keys stay denied by the engine. */
export const DATA_ROOTS = new Set([
  'relevantDates',
  'semantics',
  'locations',
  'beacons',
  'userInfo',
  'upcomingPassInformation',
  'preferredStyleSchemes',
  'maxDistance',
]);

export const POINTERS = new Set([
  '/logoText',
  '/relevantDate',
  '/expirationDate',
  '/voided',
  '/foregroundColor',
  '/backgroundColor',
  '/labelColor',
  '/stripColor',
  '/description',
  '/groupingIdentifier',
  '/eventLogoText',
  '/directionsInformationURL',
  '/parkingInformationURL',
  '/managementURL',
  '/changeSeatURL',
]);

export function pointerAllowed(pointer: unknown): boolean {
  if (typeof pointer !== 'string') return false;
  if (POINTERS.has(pointer)) return true;
  if (isAllowedPointer(pointer) !== null) return false;
  const root = parsePointer(pointer)?.[0] ?? '';
  return DATA_ROOTS.has(root) || /^\/[A-Za-z]+\/transitType$/.test(pointer);
}
