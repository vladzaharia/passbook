import { HOUR_MS, ignored, isoMs, num, obj, type Recipe, record, ref, str } from './shared.ts';

// Order payload and statuses: https://woocommerce.github.io/woocommerce-rest-api-docs/#order-properties
// Webhook topics, headers and the signature: https://woocommerce.com/document/webhooks/
const TOPICS = ['order.created', 'order.updated'];
/** Paid: processing and completed. on-hold and pending wait for payment. */
const PAID = ['processing', 'completed'];
const MAX_LINES = 100;

const cents = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number.parseFloat(v) : num(v);
  return n === null || Number.isNaN(n) ? null : Math.round(n * 100);
};

/**
 * The order payload lists refunds as `{ id, total: "-10.00" }` with no line items [verify], so a refund
 * belongs to a line only when its amount matches that one line (with or without tax). Ambiguity voids nothing.
 */
function refundedLines(lines: Record<string, unknown>[], refunds: unknown): Set<number> {
  const out = new Set<number>();
  for (const r of Array.isArray(refunds) ? refunds : []) {
    const amount = cents(obj(r)?.total);
    if (amount === null) continue;
    const hits = lines.flatMap((l, i) =>
      [cents(l.total), (cents(l.total) ?? 0) + (cents(l.total_tax) ?? 0)].includes(Math.abs(amount))
        ? [i]
        : [],
    );
    if (hits.length === 1 && hits[0] !== undefined) out.add(hits[0]);
  }
  return out;
}

export const woocommerceOrders: Recipe = {
  id: 'woocommerce-orders',
  label: 'WooCommerce orders',
  category: 'commerce',
  verifier: 'woocommerce',
  topicHeader: 'x-wc-webhook-topic',
  idPrefix: 'woocommerce',
  // Neither the signature nor the body signs a delivery time: date_modified_gmt bounds a replay.
  windowMs: 48 * HOUR_MS,
  tolerateNonJson: true,
  topics: TOPICS,
  pasteSecret: true,
  outputFields: {
    orderId: { type: 'string' },
    orderNumber: { type: 'string' },
    email: { type: 'string' },
    name: { type: 'string' },
    total: { type: 'string', description: 'Exact decimal string.' },
    currency: { type: 'string' },
    status: { type: 'string' },
    createdAt: { type: 'date' },
    itemCount: { type: 'number' },
    eventName: { type: 'string', description: 'The product; the first one for an order pass.' },
    ticketType: { type: 'string', description: 'The SKU of the line item.' },
    quantity: { type: 'number' },
    refunded: { type: 'boolean', description: 'Order: full refund. Line item: its refund.' },
  },
  mapping: {
    orderNumber: { from: '/orderId' },
    name: { from: '/name' },
    eventName: { from: '/eventName' },
    ticketType: { from: '/ticketType' },
  },
  holderEmailField: '/email',
  voidWhen: [
    { from: '/status', op: 'in', values: ['cancelled', 'refunded', 'failed', 'trash'] },
    { from: '/refunded', op: 'in', values: [true] },
  ],
  adapt({ body, topic, config }) {
    // A new webhook pings with a form body (not JSON), and order.deleted or restored are not handled.
    if (body === undefined) return ignored('ping');
    if (topic !== null && !TOPICS.includes(topic)) return ignored('unknown_type');
    const o = obj(body);
    const id = typeof o?.id === 'number' && Number.isSafeInteger(o.id) ? String(o.id) : null;
    const status = str(o?.status);
    const modified = str(o?.date_modified_gmt);
    // The *_gmt fields carry no zone: they are UTC.
    const version = isoMs(
      modified && !/(Z|[+-]\d{2}:\d{2})$/.test(modified) ? `${modified}Z` : modified,
    );
    if (!o || !id || !status || version === null) return ignored('unrecognized_shape');
    const billing = obj(o.billing);
    const lines = (Array.isArray(o.line_items) ? o.line_items : [])
      .map(obj)
      .filter((l): l is Record<string, unknown> => l !== null);
    if (lines.length > MAX_LINES) return ignored('unrecognized_shape');
    const total = cents(o.total);
    const refundCents = (Array.isArray(o.refunds) ? o.refunds : []).reduce(
      (n: number, r) => n + Math.abs(cents(obj(r)?.total) ?? 0),
      0,
    );
    const fullRefund =
      status === 'refunded' || (total !== null && total > 0 && refundCents >= total);
    const base = {
      orderId: id,
      orderNumber: str(o.number) ?? id,
      email: str(billing?.email),
      name: [str(billing?.first_name), str(billing?.last_name)].filter(Boolean).join(' ') || null,
      total: str(o.total),
      currency: str(o.currency),
      status,
      createdAt: str(o.date_created_gmt) && `${str(o.date_created_gmt)}Z`,
    };
    const open = PAID.includes(status) && !fullRefund;
    if (config.passPer !== 'line_item') {
      const key = `order:${id}`;
      const first = lines[0];
      return {
        refs: [key],
        records: {
          [key]: record({
            ...base,
            itemCount: lines.reduce((n, l) => n + (num(l.quantity) ?? 0), 0),
            eventName: str(first?.name),
            ticketType: str(first?.sku),
            refunded: fullRefund,
          }),
        },
        versions: { [key]: version },
        signedAt: version,
        createRefs: open ? [key] : [],
      };
    }
    const partly = refundedLines(lines, o.refunds);
    const keys: string[] = [];
    const records: Record<string, ReturnType<typeof record>> = {};
    lines.forEach((l, i) => {
      const lineId = typeof l.id === 'number' && Number.isSafeInteger(l.id) ? String(l.id) : null;
      const key = lineId && ref(`order:${id}:line:${lineId}`);
      if (!key) return;
      keys.push(key);
      records[key] = record({
        ...base,
        itemCount: num(l.quantity) ?? 0,
        eventName: str(l.name),
        ticketType: str(l.sku),
        quantity: num(l.quantity),
        refunded: fullRefund || partly.has(i),
      });
    });
    if (keys.length === 0) return ignored('no_ref');
    return {
      refs: keys,
      records,
      versions: Object.fromEntries(keys.map((k) => [k, version])),
      signedAt: version,
      createRefs: open ? keys.filter((k) => records[k]?.refunded !== true) : [],
    };
  },
};
