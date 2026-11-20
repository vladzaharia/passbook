import { zodToOpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import {
  WEBHOOK_EVENT_TYPES,
  WebhookEventSchema,
  type WebhookEventType,
  WebhookPassRefSchema,
} from '../../shared/contracts/webhooks.ts';
import type { AppBindings } from './context.ts';

const SUMMARY: Record<WebhookEventType, string> = {
  'pass.issued': 'A pass was created.',
  'pass.updated': 'A pass changed and a new version was published.',
  'pass.voided': 'A pass was voided.',
  'pass.unvoided': 'A void was undone.',
  'pass.removed': 'A pass was removed from Wallet.',
  'pass.restored': 'A removed pass was restored.',
  'pass.installed': "A pass was added to a device's Wallet.",
  'pass.uninstalled': "A pass left a device's Wallet.",
  'pass.scanned': 'A scan of the pass succeeded.',
  'pass.scan_refused': 'A scan of the pass was refused.',
  'pass.scan_undone': 'A scan was undone.',
  'pass.channels_changed': 'A delivery channel of the pass turned on or off.',
  'pass.printed': 'A printed ticket was issued.',
  'pass.print_voided': 'A printed ticket was voided.',
  'push.failed': 'A Wallet push for the pass failed.',
  'email.failed': 'An email for the pass failed.',
  'webhook.test': 'Sent on request to test an endpoint.',
};

/** `pass.scan_refused` -> `PassScanRefusedEvent`. */
const componentName = (type: string): string =>
  `${type.replace(/(^|[._])([a-z])/g, (_m, _s, c: string) => c.toUpperCase())}Event`;

const HEADERS = z.object({
  'x-passbook-event-id': z.string().describe('The event id; stable across retries.'),
  'x-passbook-event-type': z.string().describe('The event type, such as pass.issued.'),
  'x-passbook-timestamp': z.string().describe('Unix seconds of this attempt.'),
  'x-passbook-signature': z
    .string()
    .describe(
      'v1=<hex>, HMAC-SHA256 of `<timestamp>.<body>`; may list more than one while a secret rotates.',
    ),
});

zodToOpenAPIRegistry.add(WebhookPassRefSchema, { _internal: { refId: 'WebhookPassRef' } });
zodToOpenAPIRegistry.add(WebhookEventSchema, { _internal: { refId: 'WebhookEvent' } });
const envelopes = new Map(
  WebhookEventSchema.options.map((o) => [o.shape.type.value as WebhookEventType, o]),
);
for (const [type, schema] of envelopes)
  zodToOpenAPIRegistry.add(schema, { _internal: { refId: componentName(type) } });

const done = new WeakSet<object>();

/** Registers one OpenAPI webhook per event type; the body is the event's own component. Once per app. */
export function registerWebhookEvents(app: OpenAPIHono<AppBindings>): void {
  if (done.has(app)) return;
  done.add(app);
  for (const type of WEBHOOK_EVENT_TYPES) {
    const schema = envelopes.get(type);
    if (!schema) throw new Error(`no webhook envelope for ${type}`);
    app.openAPIRegistry.registerWebhook({
      method: 'post',
      path: type,
      summary: SUMMARY[type],
      request: { headers: HEADERS, body: { content: { 'application/json': { schema } } } },
      responses: { 200: { description: 'Any 2xx acknowledges the delivery.' } },
    });
  }
}
