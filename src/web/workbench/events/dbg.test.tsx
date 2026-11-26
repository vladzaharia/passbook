import { it } from 'vitest';
import { WebhookDeliveryListSchema } from '@/shared/contracts/webhooks.ts';
import { delivery } from './test-support.ts';

it('dbg', () => {
  const r = WebhookDeliveryListSchema.safeParse({
    items: [delivery('we1', 'ev2', 'url')],
    nextCursor: null,
  });
  throw new Error(`R ${JSON.stringify(r).slice(0, 800)}`);
});
