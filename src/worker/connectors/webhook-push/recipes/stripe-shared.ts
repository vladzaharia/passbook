import { ignored, num, obj, type RecipeOutcome, ref, str } from './shared.ts';

export interface StripeEvent {
  id: string;
  type: string;
  /** ms */
  created: number;
  object: Record<string, unknown>;
}

/** A snapshot event, or the outcome that says why it is not one. */
export function stripeEvent(body: unknown, acceptTest: boolean): StripeEvent | RecipeOutcome {
  const o = obj(body);
  if (o?.object !== 'event') return ignored('unrecognized_shape');
  const id = ref(o.id);
  const type = str(o.type);
  const created = num(o.created);
  if (!id || !type || created === null) return ignored('unrecognized_shape');
  // Thin events carry a related object, not the object: fetching it needs an API key we do not hold.
  const object = obj(obj(o.data)?.object);
  if (!object) return ignored('thin_event');
  if (o.livemode !== true && !acceptTest) return ignored('test_mode');
  return { id, type, created: created * 1000, object };
}

export const isEvent = (e: StripeEvent | RecipeOutcome): e is StripeEvent => 'type' in e;

/** The id of an object field that may be an id string or an expanded object. */
export function idOf(v: unknown): string | null {
  return ref(v) ?? ref(obj(v)?.id);
}

export function one(
  ev: StripeEvent,
  refId: string | null,
  rec: Record<string, never> | RecipeOutcome['records'][string],
  create: boolean,
): RecipeOutcome {
  if (!refId) return ignored('no_ref');
  return {
    eventId: ev.id,
    refs: [refId],
    records: { [refId]: rec },
    versions: { [refId]: ev.created },
    createRefs: create ? [refId] : [],
  };
}
