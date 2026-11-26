import { HOUR_MS, ignored, isoMs, num, obj, type Recipe, record, ref, str } from './shared.ts';
import { shopifyOrdersSetup } from './shopify-orders.setup.ts';

const TOPICS = [
  'orders/create',
  'orders/updated',
  'orders/paid',
  'orders/cancelled',
  'orders/fulfilled',
];

export const shopifyOrders: Recipe = {
  id: 'shopify-orders',
  label: 'Shopify orders',
  category: 'commerce',
  verifier: 'shopify',
  topicHeader: 'x-shopify-topic',
  idPrefix: 'shopify',
  windowMs: 48 * HOUR_MS,
  topics: TOPICS,
  pasteSecret: true,
  secretOrigin: 'provider',
  secretScope: 'account',
  line: 'Order to pass. Voids when cancelled or refunded.',
  setup: shopifyOrdersSetup,
  outputFields: {
    orderName: { type: 'string' },
    orderNumber: { type: 'number' },
    email: { type: 'string' },
    customerName: { type: 'string' },
    total: { type: 'string', description: 'Exact decimal string.' },
    currency: { type: 'string' },
    financialStatus: { type: 'string' },
    fulfillmentStatus: { type: 'string' },
    cancelledAt: { type: 'date' },
    createdAt: { type: 'date' },
    itemCount: { type: 'number' },
    firstItem: { type: 'string' },
  },
  mapping: {
    orderNumber: { from: '/orderName' },
    name: { from: '/customerName' },
    itemCount: { from: '/itemCount' },
    total: { from: '/total' },
  },
  holderEmailField: '/email',
  voidWhen: [
    { from: '/cancelledAt', op: 'present' },
    { from: '/financialStatus', op: 'in', values: ['refunded', 'voided'] },
  ],
  adapt({ body, topic }) {
    if (topic !== null && !TOPICS.includes(topic)) return ignored('unknown_type');
    const o = obj(body);
    const id = ref(o?.admin_graphql_api_id);
    if (!o || !id?.startsWith('gid://shopify/Order/')) return ignored('unrecognized_shape');
    const updated = isoMs(o.updated_at);
    if (updated === null) return ignored('unrecognized_shape');
    const customer = obj(o.customer);
    const items = Array.isArray(o.line_items) ? o.line_items.map(obj) : [];
    const name = [str(customer?.first_name), str(customer?.last_name)]
      .filter(Boolean)
      .join(' ')
      .trim();
    const cancelledAt = str(o.cancelled_at);
    return {
      refs: [id],
      records: {
        [id]: record({
          orderName: str(o.name),
          orderNumber: num(o.order_number),
          email: str(o.email) ?? str(customer?.email) ?? str(o.contact_email),
          customerName: name || null,
          total: str(o.current_total_price) ?? str(o.total_price),
          currency: str(o.currency),
          financialStatus: str(o.financial_status),
          fulfillmentStatus: str(o.fulfillment_status),
          cancelledAt,
          createdAt: str(o.created_at),
          itemCount: items.reduce((n, i) => n + (num(i?.quantity) ?? 0), 0),
          firstItem: str(items[0]?.title),
        }),
      },
      versions: { [id]: updated },
      signedAt: updated,
      createRefs: cancelledAt ? [] : [id],
    };
  },
};
