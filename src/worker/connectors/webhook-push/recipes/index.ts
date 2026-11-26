import type { SetupGuide } from '../../../../shared/contracts/connection-setup.ts';
import type { RecipeId, RecipeInfo } from '../../../../shared/contracts/connections.ts';
import { decodeJsonStrict } from '../../lib/decode.ts';
import { BODY_FUTURE_SKEW_MS, VERIFIERS, webhookSecretsOf, withinWindow } from '../../lib/hmac.ts';
import { type ConnectorContext, ConnectorError, type WebhookDelivery } from '../../types.ts';
import { calcomBookings } from './calcom-bookings.ts';
import { customSetup } from './custom.setup.ts';
import type { Recipe, RecipeConfig } from './shared.ts';
import { shopifyCustomers } from './shopify-customers.ts';
import { shopifyOrders } from './shopify-orders.ts';
import { stripePayments } from './stripe-payments.ts';
import { stripeSubscriptions } from './stripe-subscriptions.ts';
import { tickettailorTickets } from './tickettailor-tickets.ts';
import { woocommerceOrders } from './woocommerce-orders.ts';

export const RECIPES: Readonly<Record<Exclude<RecipeId, 'custom'>, Recipe>> = {
  'shopify-orders': shopifyOrders,
  'shopify-customers': shopifyCustomers,
  'stripe-subscriptions': stripeSubscriptions,
  'stripe-payments': stripePayments,
  'calcom-bookings': calcomBookings,
  'woocommerce-orders': woocommerceOrders,
  'tickettailor-tickets': tickettailorTickets,
};

/** Every sender's setup guide, `custom` included. */
export const SETUP_GUIDES: Readonly<Record<RecipeId, SetupGuide>> = {
  custom: customSetup,
  'shopify-orders': shopifyOrders.setup,
  'shopify-customers': shopifyCustomers.setup,
  'stripe-subscriptions': stripeSubscriptions.setup,
  'stripe-payments': stripePayments.setup,
  'calcom-bookings': calcomBookings.setup,
  'woocommerce-orders': woocommerceOrders.setup,
  'tickettailor-tickets': tickettailorTickets.setup,
};

/** What the console lists: everything but the executable parts. */
export const RECIPE_INFOS: readonly Omit<RecipeInfo, 'entitled'>[] = Object.values(RECIPES).map(
  ({
    id,
    label,
    category,
    pasteSecret,
    line,
    secretOrigin,
    setup,
    outputFields,
    mapping,
    holderEmailField,
    voidWhen,
  }) => ({
    id,
    label,
    category,
    pasteSecret,
    line,
    secretOrigin,
    setupVersion: setup.version,
    outputFields,
    mapping,
    holderEmailField,
    voidWhen,
  }),
);

/** Only for a recipe that has a signed non-JSON delivery; the recipe then ignores it by shape. */
function decodeOrUndefined(bytes: Uint8Array): unknown {
  try {
    return decodeJsonStrict(bytes);
  } catch (e) {
    if (e instanceof ConnectorError && e.code === 'INVALID_PAYLOAD') return undefined;
    throw e;
  }
}

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
    body: recipe.tolerateNonJson ? decodeOrUndefined(signed.bytes) : decodeJsonStrict(signed.bytes),
    digest: signed.digest,
    now,
    config,
    topic: recipe.topicHeader ? req.headers.get(recipe.topicHeader) : null,
  });
  const eventId = out.eventId ?? `${recipe.idPrefix}:${signed.digest}`;
  const previous = signed.usedPrevious ? { usedPreviousSecret: true as const } : {};
  if (out.ignored) return { eventId, refs: [], ignored: out.ignored, ...previous };
  const signedAt = verifier.replay === 'body-window' ? out.signedAt : signed.signedAt;
  if (signedAt === undefined) throw new ConnectorError('AUTH');
  if (
    verifier.replay === 'body-window' &&
    !withinWindow(now, signedAt, recipe.windowMs, BODY_FUTURE_SKEW_MS)
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
    ...previous,
  };
}
