import type {
  SetupGuide,
  SetupPart,
  SetupStep,
} from '../../../shared/contracts/connection-setup.ts';
import { calcomBookingsSetup } from '../../../worker/connectors/webhook-push/recipes/calcom-bookings.setup.ts';
import { customSetup } from '../../../worker/connectors/webhook-push/recipes/custom.setup.ts';
import { shopifyCustomersSetup } from '../../../worker/connectors/webhook-push/recipes/shopify-customers.setup.ts';
import { shopifyOrdersSetup } from '../../../worker/connectors/webhook-push/recipes/shopify-orders.setup.ts';
import { stripePaymentsSetup } from '../../../worker/connectors/webhook-push/recipes/stripe-payments.setup.ts';
import { stripeSubscriptionsSetup } from '../../../worker/connectors/webhook-push/recipes/stripe-subscriptions.setup.ts';
import { tickettailorTicketsSetup } from '../../../worker/connectors/webhook-push/recipes/tickettailor-tickets.setup.ts';
import { woocommerceOrdersSetup } from '../../../worker/connectors/webhook-push/recipes/woocommerce-orders.setup.ts';
import { outboundSetup } from '../../../worker/modules/webhooks/setup-guide.ts';

/** The directive in a guide file that stands for every setup guide. */
export const SETUP_DIRECTIVE = '{{webhook-setup}}';

/** Guides in reading order, each with the heading it gets. The recipe labels are the catalog's. */
export const SETUP_GUIDE_LIST: readonly { label: string; guide: SetupGuide }[] = [
  { label: 'Shopify orders', guide: shopifyOrdersSetup },
  { label: 'Shopify customers', guide: shopifyCustomersSetup },
  { label: 'Stripe payments', guide: stripePaymentsSetup },
  { label: 'Stripe subscriptions', guide: stripeSubscriptionsSetup },
  { label: 'Cal.com bookings', guide: calcomBookingsSetup },
  { label: 'WooCommerce orders', guide: woocommerceOrdersSetup },
  { label: 'Ticket Tailor tickets', guide: tickettailorTicketsSetup },
  { label: 'Any other system', guide: customSetup },
  { label: 'Receive webhooks from PassBook', guide: outboundSetup },
];

const COPY_FIELD: Record<string, string> = {
  endpointUrl: 'the URL PassBook shows',
  secret: 'the signing secret',
  signatureHeader: 'the signature header name PassBook shows',
  timestampHeader: 'the timestamp header name PassBook shows',
};

const TROUBLE_LABEL: Record<string, string> = {
  none: 'Nothing arrives',
  signature_missing: 'No signature',
  signature_mismatch: 'Signature does not match',
  signature_expired: 'Timestamp too old',
  payload: 'Body not readable',
  too_large: 'Body too large',
  no_secret: 'No secret set',
  unknown_type: 'Event not read',
  thin_event: 'Event without data',
  test_mode: 'Test-mode event',
  unrecognized_shape: 'Wrong kind of record',
  no_ref: 'No record id',
  ping: 'Ping',
  stale: 'Event too old',
  refused: 'Your server refused it',
  wrong_path: 'Wrong path',
  redirected: 'Redirected',
  server_error: 'Server error',
  timeout: 'No answer in time',
  unreachable: 'Not reachable',
};

const cell = (s: string) => s.replaceAll('|', '\\|');
const code = (lang: string) => (lang === 'curl' ? 'sh' : lang);

function part(p: SetupPart, g: SetupGuide): string[] {
  switch (p.t) {
    case 'text':
      return [p.text, ''];
    case 'path':
      return [`Go to ${p.items.map((i) => `**${i}**`).join(', then ')}.`, ''];
    case 'field': {
      const value = p.copy ? `Paste ${COPY_FIELD[p.copy]}.` : p.value;
      return [`- **${p.label}**: ${p.choose ? `choose ${value}` : value}`];
    }
    case 'topics':
      return [
        g.subscriptions.perWebhook === 'one' ? 'One event per webhook:' : 'Events to send:',
        '',
        ...g.subscriptions.topics.map(
          (t) =>
            `- \`${t.id}\`${t.label ? ` (${t.label})` : ''}${t.required ? '' : ', optional'}${t.verified ? '' : ', unconfirmed'}`,
        ),
        '',
      ];
    case 'code':
      return [`\`\`\`${code(p.lang)}`, p.code, '```', ''];
    case 'note':
      return [`> ${p.text}`, ''];
    case 'warn':
      return [`> **Warning:** ${p.text}`, ''];
  }
}

function step(s: SetupStep, g: SetupGuide, label: string): string[] {
  const where = s.side === 'passbook' ? 'In PassBook' : `At ${g.provider.name}`;
  const out = [
    `### ${label}: ${s.title}`,
    '',
    `${where}.${s.verified ? '' : ' Labels may differ.'}`,
    '',
  ];
  let listed = false;
  for (const p of s.parts) {
    const lines = part(p, g);
    const item = p.t === 'field';
    if (listed && !item) out.push('');
    out.push(...lines);
    listed = item;
  }
  if (listed) out.push('');
  return out;
}

function section({ label, guide: g }: { label: string; guide: SetupGuide }): string[] {
  const out = [`## ${label}`, ''];
  if (g.provider.consoleUrl) out.push(`Open ${g.provider.name} at ${g.provider.consoleUrl}.`, '');
  out.push(
    g.secret.origin === 'provider'
      ? `${g.provider.name} makes the secret. Paste it into PassBook.`
      : `PassBook makes the secret. Paste it ${g.direction === 'outbound' ? 'into your server' : `at ${g.provider.name}`}.`,
    '',
  );
  if (g.steps.some((s) => !s.verified) || g.subscriptions.topics.some((t) => !t.verified))
    out.push('Some labels are unconfirmed and may differ.', '');
  for (const s of g.steps) out.push(...step(s, g, label));
  out.push(`Test: ${g.test.text}`, '');
  const rows = Object.entries(g.troubleshooting);
  if (rows.length > 0)
    out.push(
      `| If | Then |`,
      '| --- | --- |',
      ...rows.map(
        ([k, v]) => `| ${cell(TROUBLE_LABEL[k] ?? k.replaceAll('_', ' '))} | ${cell(v)} |`,
      ),
      '',
    );
  if (g.provider.docs.length > 0)
    out.push(...g.provider.docs.map((d) => `- [${d.label}](${d.url})`), '');
  return out;
}

/** Every setup guide as guide markdown: the same data the console and the API read. */
export function setupGuidesMarkdown(): string {
  return SETUP_GUIDE_LIST.flatMap(section).join('\n').trimEnd();
}

/** Replaces the directive line with the generated sections. */
export const expandSetupDirective = (text: string): string =>
  text.includes(SETUP_DIRECTIVE)
    ? text.replace(SETUP_DIRECTIVE, () => setupGuidesMarkdown())
    : text;
