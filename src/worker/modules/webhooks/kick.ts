import { createMiddleware } from 'hono/factory';
import type { AppBindings } from '../../platform/context.ts';
import { type ServiceContext, serviceContext } from '../../platform/service-context.ts';
import { dispatchDue } from './dispatch.ts';
import { anyActiveEndpoint as readAnyActive } from './repo-delivery-read.ts';

const MEMO_MS = 30_000;
export const KICK_LANES = 10;
const READ_ONLY = new Set(['GET', 'HEAD', 'OPTIONS']);

let memo: { at: number; any: boolean } | null = null;
let lastKick = Number.NEGATIVE_INFINITY;
/** At most one kick per isolate per second: an anonymous POST flood must not become a query flood. */
const KICK_EVERY_MS = 1_000;

/** For tests: the memo is per isolate. */
export function resetKickMemo(): void {
  memo = null;
  lastKick = Number.NEGATIVE_INFINITY;
}

async function anyActiveEndpoint(ctx: ServiceContext): Promise<boolean> {
  const now = ctx.clock.now();
  if (memo && now - memo.at < MEMO_MS) return memo.any;
  memo = { at: now, any: await readAnyActive(ctx.env.DB) };
  return memo.any;
}

/** Claims the lanes that have due deliveries. Never throws: a failure waits for the minute sweep. */
export async function kick(ctx: ServiceContext): Promise<void> {
  const now = ctx.clock.now();
  if (now - lastKick < KICK_EVERY_MS) return;
  lastKick = now;
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
