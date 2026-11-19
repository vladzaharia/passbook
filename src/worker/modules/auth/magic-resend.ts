import type { Context } from 'hono';
import type { AppBindings } from '../../platform/context.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { clientIp, clientRatePrefix, enforceRateLimit } from '../../platform/rate-limit.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { requestTheme } from '../../ssr/head.ts';
import { ipPrefix, MAGIC_COOKIE, readCookie, setBindingCookie } from './cookies.ts';
import { magicLinkTrace } from './magic-peek.ts';
import { isEmailSignInEnabled, MAGIC_TTL_MS, processSignInRequest } from './magic-service.ts';
import { safeNext } from './next.ts';
import { resentPage } from './pages.ts';

/**
 * POST /auth/magic/resend. A dead sign-in link asks for a new one to the address it was for. The
 * page answers the same whether or not a mail goes out, and the caps of a public request apply.
 */
export async function resendMagic(c: Context<AppBindings>) {
  const ctx = serviceContext(c);
  await enforceRateLimit(c.env, 'RL_MAGIC_LINK', `ip:${clientRatePrefix(c)}`);
  const form = await c.req.parseBody();
  const token = typeof form.token === 'string' ? form.token : '';
  const trace = await magicLinkTrace(ctx, token);
  const next = safeNext(trace?.next);
  if (trace?.purpose === 'sign_in' && !trace.invited && (await isEmailSignInEnabled(ctx))) {
    const existing = readCookie(c, MAGIC_COOKIE);
    const binding = existing && existing.length >= 32 ? existing : ctx.ids.token(32);
    setBindingCookie(c, MAGIC_COOKIE, binding, MAGIC_TTL_MS / 1000);
    const input = {
      email: trace.email,
      bindingHash: await sha256Hex(binding),
      next,
      ipPrefix: ipPrefix(clientIp(c)),
    };
    ctx.waitUntil(processSignInRequest(ctx, input));
  }
  return c.html(resentPage(c.var.nonce, next, requestTheme(c)));
}
