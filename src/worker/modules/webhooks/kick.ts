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

/**
 * An endpoint was made in this isolate: the "none" answer the memo may hold is wrong now. Without this, the first
 * endpoint of a quiet platform (a new sandbox's capture endpoint) waits up to 30 s for its first kick.
 */
export function noteActiveEndpoint(ctx: ServiceContext): void {
  memo = { at: ctx.clock.now(), any: true };
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

let trailing = false;

/**
 * A kick for a write request. A write inside the one-second window of the last kick would otherwise leave its
 * events for the minute sweep, so it waits out the window once and kicks then: still one kick a second.
 */
export async function kickAfterWrite(ctx: ServiceContext): Promise<void> {
  const wait = KICK_EVERY_MS - (ctx.clock.now() - lastKick);
  if (wait <= 0) return kick(ctx);
  if (trailing) return;
  trailing = true;
  try {
    const pause = wait + 25;
    await (ctx.clock.sleep?.(pause) ?? new Promise((resolve) => setTimeout(resolve, pause)));
  } finally {
    trailing = false;
  }
  await kick(ctx);
}

/** After every write request, in the background: events from scans, the API and Wallet leave in seconds. */
export const webhookKick = createMiddleware<AppBindings>(async (c, next) => {
  await next();
  if (!READ_ONLY.has(c.req.method)) {
    const ctx = serviceContext(c);
    ctx.waitUntil(kickAfterWrite(ctx));
  }
});
