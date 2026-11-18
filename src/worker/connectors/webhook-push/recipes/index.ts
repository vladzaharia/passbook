import type { RecipeId, RecipeInfo } from '../../../../shared/contracts/connections.ts';
import { decodeJsonStrict, VERIFIERS, webhookSecretsOf, withinWindow } from '../../lib/hmac.ts';
import { type ConnectorContext, ConnectorError, type WebhookDelivery } from '../../types.ts';
import { calcomBookings } from './calcom-bookings.ts';
import type { Recipe, RecipeConfig } from './shared.ts';
import { shopifyCustomers } from './shopify-customers.ts';
import { shopifyOrders } from './shopify-orders.ts';
import { stripePayments } from './stripe-payments.ts';
import { stripeSubscriptions } from './stripe-subscriptions.ts';

const FUTURE_MS = 5 * 60_000;

export const RECIPES: Readonly<Record<Exclude<RecipeId, 'custom'>, Recipe>> = {
  'shopify-orders': shopifyOrders,
  'shopify-customers': shopifyCustomers,
  'stripe-subscriptions': stripeSubscriptions,
  'stripe-payments': stripePayments,
  'calcom-bookings': calcomBookings,
};

/** The oldest signed time ingress accepts from any recipe; it stays below the 7-day dedupe retention. */
export const MAX_REPLAY_AGE_MS = Math.max(
  ...Object.values(RECIPES).map((r) => r.windowMs),
  5 * 60_000,
);

/** What the console lists: everything but the executable parts. */
export const RECIPE_INFOS: readonly RecipeInfo[] = Object.values(RECIPES).map(
  ({ id, label, pasteSecret, outputFields, mapping, holderEmailField, voidWhen }) => ({
    id,
    label,
    pasteSecret,
    outputFields,
    mapping,
    holderEmailField,
    voidWhen,
  }),
);

/** Verifies, then adapts. The event id and the replay bound are decided here, from signed content only. */
export async function verifyRecipe(
  recipe: Recipe,
  ctx: Pick<ConnectorContext<unknown, unknown>, 'webhookSecret' | 'webhookSecrets' | 'now'>,
  req: Request,
  config: RecipeConfig,
): Promise<WebhookDelivery> {
  const verifier = VERIFIERS[recipe.verifier];
  const now = ctx.now();
  const signed = await verifier.verify(req, webhookSecretsOf(ctx), now);
  const out = recipe.adapt({
    body: decodeJsonStrict(signed.bytes),
    digest: signed.digest,
    now,
    config,
    topic: recipe.topicHeader ? req.headers.get(recipe.topicHeader) : null,
  });
  const eventId = out.eventId ?? `${recipe.idPrefix}:${signed.digest}`;
  if (out.ignored) return { eventId, refs: [], ignored: out.ignored };
  const signedAt = verifier.replay === 'body-window' ? out.signedAt : signed.signedAt;
  if (signedAt === undefined) throw new ConnectorError('AUTH');
  if (
    verifier.replay === 'body-window' &&
    !withinWindow(now, signedAt, recipe.windowMs, FUTURE_MS)
  ) {
    throw new ConnectorError('AUTH');
  }
  return {
    eventId,
    refs: out.refs,
    records: out.records,
    createRefs: out.createRefs,
    versions: out.versions,
    signedAt,
  };
}
