import { sameOriginOnly } from '../../platform/csrf.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createRouter } from '../../platform/openapi.ts';
import {
  ASSET_MISSES_PER_MINUTE,
  checkRateLimit,
  clientIp,
  gateMisses,
  rateLimit,
} from '../../platform/rate-limit.ts';
import { recordAudit } from '../audit/service.ts';
import { ipPrefix, MAGIC_COOKIE, setBindingCookie } from '../auth/cookies.ts';
import { MAGIC_TTL_MS, processSignInRequest } from '../auth/magic-service.ts';
import { svc } from '../passes/http.ts';
import { isTokenShape, passForToken } from './service.ts';

/**
 * /p/:token/sign-in: an ended pass's "Email me my passes". Mails a sign-in link to the pass's own
 * holder email, whatever state the pass is in. The address is never shown or returned, and the
 * link is the ordinary email one: it opens a holder (`user`) session, never an admin one. The
 * same gates as resend apply (RL_PUBLIC, then the hourly per-pass cap), then the sign-in caps.
 */
export const signInRoutes = createRouter();
signInRoutes.use('/:token/sign-in', sameOriginOnly);
signInRoutes.use('/:token/sign-in', gateMisses(ASSET_MISSES_PER_MINUTE));
signInRoutes.use('/:token/sign-in', rateLimit('RL_PUBLIC'));
signInRoutes.post('/:token/sign-in', async (c) => {
  const token = c.req.param('token');
  // Unknown, ended and live tokens all answer "sent": nothing says which exists. Only a malformed
  // token is refused, before it can reach a Location header.
  if (!isTokenShape(token)) return c.text('Not found', 404);
  const back = (state: 'sent' | 'wait') => c.redirect(`/p/${token}?signin=${state}`, 303);
  const ctx = svc(c);
  const pass = await passForToken(ctx, token).catch(() => null);
  if (!pass?.holderEmail) return back('sent');
  if (!(await checkRateLimit(ctx.env, 'RL_REFRESH', `signin:${token}`))) return back('wait');
  const binding = ctx.ids.token(32);
  setBindingCookie(c, MAGIC_COOKIE, binding, MAGIC_TTL_MS / 1000);
  const prefix = ipPrefix(clientIp(c));
  await recordAudit(ctx, {
    orgId: pass.orgId,
    actorType: 'system',
    action: 'holder.sign_in_requested',
    targetType: 'pass',
    targetId: pass.id,
    ipPrefix: prefix,
    detail: { state: pass.removedAt !== null ? 'removed' : pass.status },
  });
  ctx.waitUntil(
    processSignInRequest(ctx, {
      email: pass.holderEmail,
      bindingHash: await sha256Hex(binding),
      next: '/',
      ipPrefix: prefix,
    }),
  );
  return back('sent');
});
