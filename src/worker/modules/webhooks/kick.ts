import { createMiddleware } from 'hono/factory';
import type { AppBindings } from '../../platform/context.ts';
import { first } from '../../platform/db.ts';
import { type ServiceContext, serviceContext } from '../../platform/service-context.ts';
import { dispatchDue } from './dispatch.ts';

const MEMO_MS = 30_000;
export const KICK_LANES = 10;
const READ_ONLY = new Set(['GET', 'HEAD', 'OPTIONS']);

let memo: { at: number; any: boolean } | null = null;

/** For tests: the memo is per isolate. */
export function resetKickMemo(): void {
  memo = null;
}

async function anyActiveEndpoint(ctx: ServiceContext): Promise<boolean> {
  const now = ctx.clock.now();
  if (memo && now - memo.at < MEMO_MS) return memo.any;
  const row = await first(
    ctx.env.DB,
    "SELECT 1 FROM webhook_endpoints WHERE status = 'active' LIMIT 1",
  );
  memo = { at: now, any: row !== null };
  return memo.any;
}

/** Claims the lanes that have due deliveries. Never throws: a failure waits for the minute sweep. */
export async function kick(ctx: ServiceContext): Promise<void> {
  try {
    if (await anyActiveEndpoint(ctx)) await dispatchDue(ctx, KICK_LANES);
  } catch (error) {
    ctx.log.warn('webhooks.kick_failed', { code: 'WEBHOOK_KICK_FAILED', error });
  }
}

/** After every write request, in the background: events from scans, the API and Wallet leave in seconds. */
export const webhookKick = createMiddleware<AppBindings>(async (c, next) => {
  await next();
  if (!READ_ONLY.has(c.req.method)) {
    const ctx = serviceContext(c);
    ctx.waitUntil(kick(ctx));
  }
});
