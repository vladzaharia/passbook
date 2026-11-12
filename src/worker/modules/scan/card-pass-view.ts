import {
  COLOR_KEYS,
  FIELD_GROUPS,
  PREFERRED_STYLE_SCHEMES,
  TRANSIT_TYPES,
} from '../../../passkit/schema/constants.ts';
import { PASS_STYLES } from '../../../passkit/types.ts';
import type { Json } from '../../../shared/contracts/common.ts';
import { parseColor } from '../../../shared/pass-view/color.ts';
import { visibleFields } from './card-semantics.ts';
import {
  type CardPrivacy,
  FIELD_PROPERTIES,
  fieldPropertyAllowed,
  ISO_DATE,
  record,
} from './dto-projection.ts';
import { fieldSemantics, rootSemantics } from './dto-semantics.ts';
import type { ScanActor } from './guard.ts';
import { scanPrivateName } from './projection-privacy.ts';
import type { Found } from './resolve.ts';

/** Only appearance and source-authorized field properties needed by the preview leave the server. */
export function passViewJson(found: Found, actor: ScanActor, privacy: CardPrivacy): Json {
  const raw = found.passJson as unknown as Record<string, unknown>;
  const original = found.template.passJson as unknown as Record<string, unknown>;
  const out: Record<string, Json> = {};
  const fieldsVisible = visibleFields(found, actor);
  const semantics = rootSemantics(found, privacy);
  if (semantics) out.semantics = semantics;
  const pointerVisible = privacy.pointerVisible;
  const copyScalar = (
    source: Record<string, unknown>,
    target: Record<string, Json>,
    key: string,
  ) => {
    const value = source[key];
    if (privacy.safe(value)) target[key] = value;
  };
  for (const key of ['organizationName', 'description', 'logoText', 'eventLogoText'] as const)
    if (typeof raw[key] === 'string' && pointerVisible([key])) copyScalar(raw, out, key);
  for (const key of COLOR_KEYS)
    if (parseColor(raw[key]) && pointerVisible([key])) copyScalar(raw, out, key);
  for (const key of ['voided', 'useAutomaticColors', 'suppressHeaderDarkening'] as const)
    if (typeof raw[key] === 'boolean' && pointerVisible([key])) copyScalar(raw, out, key);
  for (const key of ['expirationDate', 'relevantDate'] as const)
    if (typeof raw[key] === 'string' && ISO_DATE.test(raw[key]) && pointerVisible([key]))
      copyScalar(raw, out, key);
  if (raw.formatVersion === 1 && privacy.safe(1)) out.formatVersion = 1;
  if (Array.isArray(raw.preferredStyleSchemes) && pointerVisible(['preferredStyleSchemes'])) {
    out.preferredStyleSchemes = raw.preferredStyleSchemes.filter(
      (value): value is string =>
        typeof value === 'string' &&
        (PREFERRED_STYLE_SCHEMES as readonly string[]).includes(value) &&
        privacy.safe(value),
    );
  }
  for (const style of PASS_STYLES) {
    const block = record(raw[style]);
    if (!block) continue;
    const authored = record(original[style]);
    const result: Record<string, Json> = {};
    if (
      typeof block.transitType === 'string' &&
      (TRANSIT_TYPES as readonly string[]).includes(block.transitType) &&
      pointerVisible([style, 'transitType'])
    )
      copyScalar(block, result, 'transitType');
    for (const group of FIELD_GROUPS) {
      const fields = block[group];
      if (!Array.isArray(fields)) continue;
      const originals = Array.isArray(authored?.[group]) ? (authored[group] as unknown[]) : [];
      const projected: Json[] = [];
      for (const candidate of fields) {
        const field = record(candidate);
        if (!field) continue;
        const key = field.key;
        if (
          typeof key !== 'string' ||
          scanPrivateName(key) ||
          !privacy.safe(key) ||
          privacy.hidden.has(key)
        )
          continue;
        const bindings = privacy.fieldBindings(key);
        if (!privacy.fieldVisible(key) || !Object.hasOwn(fieldsVisible, key)) continue;
        const base = originals.map(record).find((item) => item?.key === key);
        const fieldOut: Record<string, Json> = { key };
        for (const prop of FIELD_PROPERTIES) {
          const value = field[prop];
          const bound = bindings.some(
            (binding) =>
              'field' in binding.to &&
              (binding.to.prop ?? 'value') === prop &&
              binding.value !== undefined,
          );
          if (
            fieldPropertyAllowed(prop, value) &&
            privacy.safe(value) &&
            (bound || (base && Object.hasOwn(base, prop) && base[prop] === value))
          )
            fieldOut[prop] = value;
        }
        if (Object.hasOwn(fieldOut, 'value')) {
          const semantics = fieldSemantics(found, privacy, style, group, field);
          if (semantics) fieldOut.semantics = semantics;
          projected.push(fieldOut);
        }
      }
      result[group] = projected;
    }
    out[style] = result;
  }
  return out;
}
