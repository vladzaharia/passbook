import { bump } from '../../platform/counters.ts';
import { sameOriginOnly } from '../../platform/csrf.ts';
import { RateLimitedError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createRouter } from '../../platform/openapi.ts';
import {
  checkRateLimit,
  clientIp,
  clientRatePrefix,
  rateLimit,
} from '../../platform/rate-limit.ts';
import { recordAudit } from '../audit/service.ts';
import { ipPrefix, MAGIC_COOKIE, readCookie, setBindingCookie } from '../auth/cookies.ts';
import { isEmailSignInEnabled, MAGIC_TTL_MS, processSignInRequest } from '../auth/magic-service.ts';
import { isPreviewOnlyOrg } from '../developer/fence.ts';
import { svc } from '../passes/http.ts';
import { isTokenShape, passForToken } from './service.ts';

/**
 * /p/:token/sign-in: an ended pass's "Email me my passes". Mails a sign-in link to the pass's own
 * holder email, whatever state the pass is in. The address is never shown or returned, and the
 * link is the ordinary email one: it opens a holder (`user`) session, never an admin one. The
 * gates: RL_PUBLIC, a counted miss limit, RL_REFRESH and 3 mails an hour per pass, then the sign-in
 * caps. A test-mode pass or a developer org's pass sends nothing (no real mail from a sandbox), and
 * nothing is sent while email sign-in is off; all of those answer "sent".
 */
export const signInRoutes = createRouter();
const HOUR = 3_600_000;
const PER_PASS_HOUR = 3;
const MISSES_PER_MINUTE = 20;
signInRoutes.use('/:token/sign-in', sameOriginOnly);
signInRoutes.use('/:token/sign-in', rateLimit('RL_PUBLIC'));
signInRoutes.post('/:token/sign-in', async (c) => {
  const token = c.req.param('token');
  // Unknown, ended and live tokens all answer "sent" with the same cookie: nothing says which
  // exists. Only a malformed token is refused, before it can reach a Location header.
  if (!isTokenShape(token)) return c.text('Not found', 404);
  const back = (state: 'sent' | 'wait') => c.redirect(`/p/${token}?signin=${state}`, 303);
  const ctx = svc(c);
  const now = ctx.clock.now();
  // The browser binding the code needs; an earlier one is kept so its code still works.
  const existing = readCookie(c, MAGIC_COOKIE);
  const binding = existing && existing.length >= 32 ? existing : ctx.ids.token(32);
  setBindingCookie(c, MAGIC_COOKIE, binding, MAGIC_TTL_MS / 1000);
  const pass = await passForToken(ctx, token).catch(() => null);
  if (!pass) {
    const prefix = clientRatePrefix(c);
    if ((await bump(ctx.env.DB, `signin.miss:${prefix}`, now - (now % 60_000))) > MISSES_PER_MINUTE)
      throw new RateLimitedError(60);
    return back('sent');
  }
  if (
    !pass.holderEmail ||
    pass.mode === 'test' ||
    (await isPreviewOnlyOrg(ctx.env.DB, pass.orgId)) ||
    !(await isEmailSignInEnabled(ctx))
  )
    return back('sent');
  if (
    !(await checkRateLimit(ctx.env, 'RL_REFRESH', `signin:${token}`)) ||
    (await bump(ctx.env.DB, `holder-signin:pass:${pass.id}`, now - (now % HOUR))) > PER_PASS_HOUR
  )
    return back('wait');
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
