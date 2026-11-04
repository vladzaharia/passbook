import type { BehaviorPlugin, Json, JsonSchemaObject, PassJson } from '../../types.ts';

export interface BeaconConfig {
  proximityUUID: string;
  major?: number;
  minor?: number;
  relevantText?: string;
}

export interface BeaconsConfig {
  /** Beacons every pass carries. They come first and are never cut. */
  beacons?: BeaconConfig[];
  /** Input holding an array of beacons for this pass. */
  input?: string;
  /** Lowers the cap of 10. */
  max?: number;
}

const UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
const MAX_BEACONS = 10;

const beaconSchema: Json = {
  type: 'object',
  required: ['proximityUUID'],
  additionalProperties: false,
  properties: {
    proximityUUID: { type: 'string', minLength: 1 },
    major: { type: 'integer', minimum: 0, maximum: 65535 },
    minor: { type: 'integer', minimum: 0, maximum: 65535 },
    relevantText: { type: 'string', maxLength: 200 },
  },
};

const configSchema: JsonSchemaObject = {
  type: 'object',
  additionalProperties: false,
  properties: {
    beacons: { type: 'array', maxItems: MAX_BEACONS, items: beaconSchema },
    input: { type: 'string', minLength: 1 },
    max: { type: 'integer', minimum: 1, maximum: MAX_BEACONS },
  },
};

const isUint16 = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 65535;

/** Throws a sentence that names the row, so the form can show it as is. */
function read(raw: unknown, label: string): Record<string, Json> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new Error(`${label} is not a beacon.`);
  const row = raw as Record<string, Json>;
  const uuid = typeof row.proximityUUID === 'string' ? row.proximityUUID.trim() : '';
  if (!UUID.test(uuid))
    throw new Error(`${label} needs a UUID like 8DEEFBB9-F738-4297-8040-96668BB44281.`);
  const out: Record<string, Json> = { proximityUUID: uuid.toUpperCase() };
  for (const key of ['major', 'minor'] as const) {
    const value = row[key];
    if (value === undefined || value === null || value === '') continue;
    if (!isUint16(value)) throw new Error(`${label}: ${key} is a whole number from 0 to 65535.`);
    out[key] = value;
  }
  if (out.minor !== undefined && out.major === undefined)
    throw new Error(`${label}: set major when you set minor.`);
  const text = typeof row.relevantText === 'string' ? row.relevantText.trim() : '';
  if (text) out.relevantText = text.slice(0, 200);
  return out;
}

/**
 * Sets `beacons` from static config and an optional input array. Static beacons come first,
 * duplicates collapse, and the list stops at the cap. No beacons removes the key.
 */
export const beacons: BehaviorPlugin<BeaconsConfig> = {
  id: 'beacons',
  version: 1,
  configSchema,
  apply(pass, input, config) {
    const rows = [
      ...(config.beacons ?? []).map((b, i) =>
        read(b as unknown, `Beacon ${i + 1} in the template`),
      ),
    ];
    const supplied = config.input ? input[config.input] : undefined;
    if (supplied !== undefined && supplied !== null) {
      if (!Array.isArray(supplied)) throw new Error(`${config.input} is not a list.`);
      supplied.forEach((raw, i) => {
        rows.push(read(raw, `Beacon ${i + 1}`));
      });
    }
    const seen = new Set<string>();
    const unique = rows.filter((b) => {
      const id = `${b.proximityUUID}/${b.major ?? ''}/${b.minor ?? ''}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    const list = unique.slice(0, config.max ?? MAX_BEACONS);
    if (list.length > 0) pass.beacons = list as unknown as PassJson['beacons'];
    else delete pass.beacons;
  },
};

export default beacons;
