import { type ExprScope, evaluate } from '../../template/expr.ts';
import type { BehaviorPlugin, Json, JsonSchemaObject, PassField, PassJson } from '../../types.ts';

export interface VenueLocationsConfig {
  /** Name of the lookup table that holds the venues. */
  venues: string;
  homeInput?: string;
  accessInput?: string;
  /** `accessInput` value that makes every venue eligible. */
  allValue?: string;
  /** Expression; `{{venue.*}}` is the venue record, inputs are in scope too. */
  relevantText?: string;
  latitude?: string;
  longitude?: string;
  /** Meters. Can only shrink Wallet's default radius. A venue's own `maxDistance` wins. */
  maxDistance?: number;
  placeAction?: { identifier: string; field?: string };
  directions?: {
    group?: string;
    after?: string;
    key: string;
    label?: string;
    value: string;
    linkText: string;
    url: string;
    /** Appended to the key per style dictionary, so keys stay unique across the pass. */
    keySuffix?: Record<string, string>;
  };
}

const MAX_LOCATIONS = 10;

const configSchema: JsonSchemaObject = {
  type: 'object',
  required: ['venues'],
  additionalProperties: false,
  properties: {
    venues: { type: 'string', minLength: 1 },
    homeInput: { type: 'string' },
    accessInput: { type: 'string' },
    allValue: { type: 'string' },
    relevantText: { type: 'string', maxLength: 200 },
    latitude: { type: 'string' },
    longitude: { type: 'string' },
    maxDistance: { type: 'number', exclusiveMinimum: 0 },
    placeAction: {
      type: 'object',
      required: ['identifier'],
      additionalProperties: false,
      properties: { identifier: { type: 'string' }, field: { type: 'string' } },
    },
    directions: {
      type: 'object',
      required: ['key', 'value', 'linkText', 'url'],
      additionalProperties: false,
      properties: {
        group: { type: 'string' },
        after: { type: 'string' },
        key: { type: 'string' },
        label: { type: 'string' },
        value: { type: 'string' },
        linkText: { type: 'string' },
        url: { type: 'string' },
        keySuffix: { type: 'object', additionalProperties: { type: 'string' } },
      },
    },
  },
};

function html(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function str(value: Json | undefined): string {
  return value === undefined || value === null ? '' : String(value);
}

function addDirections(
  pass: PassJson,
  venueRecords: { id: string; record: Record<string, Json> }[],
  config: NonNullable<VenueLocationsConfig['directions']>,
  scope: ExprScope,
): void {
  const group = config.group ?? 'backFields';
  for (const style of [
    'generic',
    'posterGeneric',
    'storeCard',
    'coupon',
    'eventTicket',
    'boardingPass',
  ] as const) {
    const dict = pass[style] as Record<string, unknown> | undefined;
    if (!dict) continue;
    const fields = ((dict[group] as PassField[] | undefined) ?? []).slice();
    const added: PassField[] = venueRecords.map(({ record }) => {
      const venueScope = { ...scope, input: { ...scope.input, venue: record } };
      const field: PassField = {
        key: str(evaluate(config.key, venueScope)) + (config.keySuffix?.[style] ?? ''),
        value: str(evaluate(config.value, venueScope)),
      };
      if (config.label) field.label = str(evaluate(config.label, venueScope));
      const url = str(evaluate(config.url, venueScope));
      const text = str(evaluate(config.linkText, venueScope));
      field.attributedValue = `<a href="${html(url)}">${html(text)}</a>`;
      return field;
    });
    const at = config.after
      ? fields.findIndex(
          (f) =>
            f.key === config.after || f.key === `${config.after}${config.keySuffix?.[style] ?? ''}`,
        )
      : -1;
    fields.splice(at === -1 ? fields.length : at + 1, 0, ...added);
    dict[group] = fields;
  }
}

export const venueLocations: BehaviorPlugin<VenueLocationsConfig> = {
  id: 'venue-locations',
  version: 1,
  configSchema,
  apply(pass, input, config, ctx) {
    const venues = ctx.lookups[config.venues] ?? {};
    const home = config.homeInput ? input[config.homeInput] : undefined;
    const homeId = typeof home === 'string' && Object.hasOwn(venues, home) ? home : undefined;
    const allAccess =
      config.accessInput !== undefined && input[config.accessInput] === (config.allValue ?? 'all');

    let eligible = allAccess ? Object.keys(venues) : homeId ? [homeId] : [];
    if (eligible.length > MAX_LOCATIONS) {
      const rest = eligible
        .filter((id) => id !== homeId)
        .slice(0, MAX_LOCATIONS - (homeId ? 1 : 0));
      eligible = homeId ? [homeId, ...rest] : rest;
    }
    const scope: ExprScope = { input, lookups: ctx.lookups };
    const latKey = config.latitude ?? 'lat';
    const lngKey = config.longitude ?? 'lng';
    const records = eligible.map((id) => ({
      id,
      record: { id, ...(venues[id] ?? {}) } as Record<string, Json>,
    }));

    const locations = records.flatMap(({ record }) => {
      const latitude = record[latKey];
      const longitude = record[lngKey];
      if (typeof latitude !== 'number' || typeof longitude !== 'number') return [];
      const location: Record<string, Json> = { latitude, longitude };
      if (config.relevantText) {
        const text = str(
          evaluate(config.relevantText, { ...scope, input: { ...input, venue: record } }),
        );
        if (text) location.relevantText = text;
      }
      const maxDistance = record.maxDistance ?? config.maxDistance;
      if (typeof maxDistance === 'number') location.maxDistance = maxDistance;
      return [location];
    });
    if (locations.length > 0) pass.locations = locations as unknown as PassJson['locations'];
    else delete pass.locations;

    if (config.placeAction) {
      const place = homeId ? venues[homeId]?.[config.placeAction.field ?? 'place'] : undefined;
      const actions = (pass.featuredActions ?? []) as Json[];
      const action = actions.find(
        (a) => (a as { identifier?: string } | null)?.identifier === config.placeAction?.identifier,
      ) as Record<string, Json> | undefined;
      if (action) {
        if (typeof place === 'string' && place) action.placeIdentifier = place;
        else pass.featuredActions = actions.filter((a) => a !== action) as typeof pass.featuredActions;
      }
    }

    if (config.directions) addDirections(pass, records, config.directions, scope);
  },
};

export default venueLocations;
