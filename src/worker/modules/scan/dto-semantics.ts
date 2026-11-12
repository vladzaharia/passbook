import { parsePointer } from '../../../passkit/template/pointer.ts';
import type { ResolvedTemplate } from '../../../passkit/template/registry.ts';
import type { Json } from '../../../shared/contracts/common.ts';
import { type CardPrivacy, record } from './dto-projection.ts';
import type { Found } from './resolve.ts';

// Only tags the preview renderer uses, plus the four required to select a poster event layout.
const SEMANTIC_KEYS = [
  'eventName',
  'venueName',
  'venueRegionName',
  'venueRoom',
  'eventStartDate',
  'admissionLevel',
  'departureAirportCode',
  'destinationAirportCode',
  'departureCityName',
  'departureAirportName',
  'destinationCityName',
  'destinationAirportName',
  'currentDepartureDate',
  'originalDepartureDate',
  'currentArrivalDate',
  'originalArrivalDate',
  'departureLocationTimeZone',
  'destinationLocationTimeZone',
  'departureGate',
  'flightCode',
] as const;
const SEAT_KEYS = ['seatSection', 'seatRow', 'seatNumber', 'seatIdentifier'] as const;

type Permit = (path: string[], value: string) => boolean;

function project(
  source: unknown,
  privacy: CardPrivacy,
  permit: Permit,
): Record<string, Json> | undefined {
  const object = record(source);
  if (!object) return undefined;
  const out: Record<string, Json> = {};
  for (const key of SEMANTIC_KEYS) {
    const value = object[key];
    if (typeof value === 'string' && privacy.safe(value) && permit([key], value)) out[key] = value;
  }
  if (Array.isArray(object.seats)) {
    const seats: Json[] = [];
    for (const [index, candidate] of object.seats.entries()) {
      const seat = record(candidate);
      if (!seat) continue;
      const projected: Record<string, Json> = {};
      for (const key of SEAT_KEYS) {
        const value = seat[key];
        if (
          typeof value === 'string' &&
          privacy.safe(value) &&
          permit(['seats', String(index), key], value)
        )
          projected[key] = value;
      }
      if (Object.keys(projected).length > 0) seats.push(projected);
    }
    if (seats.length > 0) out.seats = seats;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function at(root: unknown, path: string[]): unknown {
  let value = root;
  for (const key of path) {
    if (Array.isArray(value)) {
      if (!/^(?:0|[1-9]\d*)$/.test(key)) return undefined;
      value = value[Number(key)];
    } else {
      const object = record(value);
      if (!object || !Object.hasOwn(object, key)) return undefined;
      value = object[key];
    }
  }
  return value;
}

function bound(template: ResolvedTemplate, path: string[]): boolean {
  return template.manifest.bindings.some((binding) => {
    if (!('pointer' in binding.to) || binding.value === undefined) return false;
    const target = parsePointer(binding.to.pointer);
    return !!target && target.length <= path.length && target.every((part, i) => path[i] === part);
  });
}

/** Root tags must be authored unchanged or bound from authorized sources in both versions. */
export function rootSemantics(
  found: Found,
  privacy: CardPrivacy,
): Record<string, Json> | undefined {
  const templates = [found.template, found.activePolicy ?? found.activeTemplate ?? found.template];
  return project(found.passJson.semantics, privacy, (path, value) => {
    const target = ['semantics', ...path];
    return (
      privacy.pointerVisible(target) &&
      templates.every(
        (template) => at(template.passJson, target) === value || bound(template, target),
      )
    );
  });
}

function fieldOf(template: ResolvedTemplate, style: string, group: string, key: string) {
  const fields = at(template.passJson, [style, group]);
  return Array.isArray(fields) ? fields.map(record).find((field) => field?.key === key) : undefined;
}

/** Field tags have no supported binding target, so only unchanged authored tags are projected. */
export function fieldSemantics(
  found: Found,
  privacy: CardPrivacy,
  style: string,
  group: string,
  field: Record<string, unknown>,
): Record<string, Json> | undefined {
  const key = field.key;
  if (typeof key !== 'string' || privacy.hidden.has(key) || !privacy.fieldVisible(key))
    return undefined;
  const templates = [found.template, found.activePolicy ?? found.activeTemplate ?? found.template];
  return project(field.semantics, privacy, (path, value) =>
    templates.every(
      (template) => at(fieldOf(template, style, group, key)?.semantics, path) === value,
    ),
  );
}
