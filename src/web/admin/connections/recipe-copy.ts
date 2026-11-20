import type { RecipeId, RecipeInfo } from '@/shared/contracts/connections.ts';
import { type MappingRow, toRows } from '../mapping/mapping.ts';

export const CUSTOM_LINE = 'Signed records in your format.';

/** What each sender needs, in the words of its own console. */
export const RECIPE_COPY: Record<
  Exclude<RecipeId, 'custom'>,
  { line: string; secretHelp: string; topics: string[] }
> = {
  'shopify-orders': {
    line: 'Order to pass. Voids when cancelled or refunded.',
    secretHelp: 'From Shopify: Settings, Notifications, Webhooks.',
    topics: ['orders/create', 'orders/updated', 'orders/cancelled'],
  },
  'shopify-customers': {
    line: 'Customer to card.',
    secretHelp: 'From Shopify: Settings, Notifications, Webhooks.',
    topics: ['customers/create', 'customers/update'],
  },
  'stripe-subscriptions': {
    line: 'Subscription to membership. Voids when cancelled.',
    secretHelp: 'From Stripe: Webhooks, your endpoint, Reveal secret.',
    topics: [
      'checkout.session.completed',
      'customer.subscription.updated',
      'customer.subscription.deleted',
    ],
  },
  'stripe-payments': {
    line: 'Payment to ticket. Voids on full refund.',
    secretHelp: 'From Stripe: Webhooks, your endpoint, Reveal secret.',
    topics: ['checkout.session.completed', 'charge.refunded'],
  },
  'calcom-bookings': {
    line: 'Booking to pass. Voids when cancelled or moved.',
    secretHelp: 'Paste the signing secret below into Cal.com: Settings, Developer, Webhooks.',
    topics: ['BOOKING_CREATED', 'BOOKING_RESCHEDULED', 'BOOKING_CANCELLED'],
  },
  'woocommerce-orders': {
    line: 'Order or line item to pass. Voids when cancelled or refunded.',
    secretHelp: 'The secret you set in WooCommerce: Settings, Advanced, Webhooks.',
    topics: ['order.created', 'order.updated'],
  },
  'tickettailor-tickets': {
    line: 'Issued ticket to pass. Voids when voided or refunded.',
    secretHelp: 'From Ticket Tailor: Settings, Integrations, Webhooks, signing secret.',
    topics: ['ISSUED_TICKET.CREATED', 'ISSUED_TICKET.UPDATED'],
  },
};

export const recipeLine = (id: RecipeId) => (id === 'custom' ? CUSTOM_LINE : RECIPE_COPY[id].line);

/** Config keys a sender other than Custom does not use: its own scheme fixes them. */
const CUSTOM_ONLY = [
  'recordsPointer',
  'refPointer',
  'recordPointer',
  'deletedPointer',
  'eventIdPointer',
  'signatureHeader',
  'timestampHeader',
];

/** Fields the config form leaves out for the chosen sender. */
export function recipeHidden(recipe: RecipeId | undefined, offered: boolean): Set<string> {
  if (!offered) return new Set();
  const hidden = new Set(['recipe']);
  if (recipe && recipe !== 'custom') for (const k of CUSTOM_ONLY) hidden.add(k);
  if (!recipe?.startsWith('stripe-')) hidden.add('acceptTestEvents');
  if (recipe !== 'woocommerce-orders') hidden.add('passPer');
  return hidden;
}

/** The mapping, holder email and void rules a sender starts with; all stay editable. */
export function recipeSeed(recipe: RecipeInfo | undefined): {
  rows: MappingRow[];
  holderEmailField: string;
  voidWhen: RecipeInfo['voidWhen'];
} {
  return {
    rows: toRows(recipe?.mapping),
    holderEmailField: recipe?.holderEmailField ?? '',
    voidWhen: recipe?.voidWhen ?? [],
  };
}

/** A pasted signing secret: the server's length, and Stripe's prefix. */
export function signingSecretError(recipe: RecipeId, value: string): string | undefined {
  const v = value.trim();
  if (!v) return 'Paste the signing secret.';
  if (v.length < 16) return 'Too short. Copy the whole secret.';
  if (recipe.startsWith('stripe-') && !v.startsWith('whsec_'))
    return 'A Stripe signing secret starts with whsec_.';
  return undefined;
}
