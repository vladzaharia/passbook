// The exact text of the generated catalog files, shared by gen-error-catalog and check-developers.
import { z } from 'zod';
import { WEBHOOK_EVENT_TYPES, WebhookEventSchema } from '../../src/shared/contracts/webhooks.ts';
import { SUMMARY } from '../../src/worker/platform/openapi-webhooks.ts';
import { buildErrorCatalog } from './error-catalog.ts';

export const buildErrorCatalogFile = (): string =>
  `${JSON.stringify(buildErrorCatalog(), null, 2)}\n`;

export function buildEventCatalog(): string {
  const schemas = new Map(
    WebhookEventSchema.options.map((o) => [o.shape.type.value as string, o] as const),
  );
  const events = WEBHOOK_EVENT_TYPES.map((type) => ({
    type,
    summary: SUMMARY[type],
    schema: z.toJSONSchema(schemas.get(type) as z.ZodType, { unrepresentable: 'any' }),
  }));
  return `${JSON.stringify({ events }, null, 2)}\n`;
}
