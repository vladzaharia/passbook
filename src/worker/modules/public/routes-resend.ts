import { sameOriginOnly } from '../../platform/csrf.ts';
import { createRouter } from '../../platform/openapi.ts';
import {
  ASSET_MISSES_PER_MINUTE,
  gateMisses,
  rateLimit,
  tokenBucket,
} from '../../platform/rate-limit.ts';
import { assertRecipientBudget } from '../me/service-help.ts';
import { svc } from '../passes/http.ts';
import { isTokenShape, passForToken } from './service.ts';

/** /p/:token/resend: the pass page's Send it again. Mails the pass to its own holder email only. */
export const resendRoutes = createRouter();
resendRoutes.use('/:token/resend', sameOriginOnly);
resendRoutes.use('/:token/resend', gateMisses(ASSET_MISSES_PER_MINUTE));
resendRoutes.use('/:token/resend', rateLimit('RL_PUBLIC'));
resendRoutes.use(
  '/:token/resend',
  rateLimit('RL_REFRESH', async (c) => `resend:${await tokenBucket(c.req.param('token') ?? '')}`),
);
resendRoutes.post('/:token/resend', async (c) => {
  const token = c.req.param('token');
  // Unknown, voided and valid tokens all answer "sent"; the mail job decides. Only a malformed
  // token is refused, before it can reach a Location header.
  if (!isTokenShape(token)) return c.text('Not found', 404);
  const back = (state: 'sent' | 'wait') => c.redirect(`/p/${token}?again=${state}`, 303);
  const ctx = svc(c);
  const pass = await passForToken(ctx, token).catch(() => null);
  if (!pass?.holderEmail || pass.status === 'voided' || pass.removedAt !== null)
    return back('sent');
  try {
    await assertRecipientBudget(ctx, pass.mode, pass.holderEmail);
  } catch {
    return back('wait');
  }
  await ctx.env.JOBS.send({
    kind: 'pass.holder_mail',
    passId: pass.id,
    userId: null,
    reason: 'resend',
  });
  return back('sent');
});
