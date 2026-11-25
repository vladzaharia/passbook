import { HOUR_MS, ignored, isoMs, num, obj, type Recipe, record, ref, str } from './shared.ts';

const TOPICS = ['customers/create', 'customers/update'];

export const shopifyCustomers: Recipe = {
  id: 'shopify-customers',
  label: 'Shopify customers',
  category: 'commerce',
  verifier: 'shopify',
  topicHeader: 'x-shopify-topic',
  idPrefix: 'shopify',
  windowMs: 48 * HOUR_MS,
  topics: TOPICS,
  pasteSecret: true,
  outputFields: {
    email: { type: 'string' },
    firstName: { type: 'string' },
    lastName: { type: 'string' },
    name: { type: 'string' },
    tags: { type: 'string' },
    state: { type: 'string' },
    ordersCount: { type: 'number' },
    createdAt: { type: 'date' },
  },
  mapping: { name: { from: '/name' } },
  holderEmailField: '/email',
  voidWhen: [],
  adapt({ body, topic }) {
    if (topic !== null && !TOPICS.includes(topic)) return ignored('unknown_type');
    const o = obj(body);
    const id = ref(o?.admin_graphql_api_id);
    if (!o || !id?.startsWith('gid://shopify/Customer/')) return ignored('unrecognized_shape');
    const updated = isoMs(o.updated_at);
    if (updated === null) return ignored('unrecognized_shape');
    const first = str(o.first_name);
    const last = str(o.last_name);
    return {
      refs: [id],
      records: {
        [id]: record({
          email: str(o.email),
          firstName: first,
          lastName: last,
          name: [first, last].filter(Boolean).join(' ').trim() || null,
          tags: str(o.tags),
          state: str(o.state),
          ordersCount: num(o.orders_count) ?? undefined,
          createdAt: str(o.created_at),
        }),
      },
      versions: { [id]: updated },
      signedAt: updated,
      createRefs: [id],
    };
  },
};
