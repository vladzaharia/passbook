import { sameOriginOnly } from '../../platform/csrf.ts';
import { createRouter } from '../../platform/openapi.ts';
import { rateLimit } from '../../platform/rate-limit.ts';
import { assertRecipientBudget } from '../me/service-help.ts';
import { svc } from '../passes/http.ts';
import { isTokenShape, passForToken } from './service.ts';

/** /p/:token/resend: the pass page's Send it again. Mails the pass to its own holder email only. */
export const resendRoutes = createRouter();
resendRoutes.use('/:token/resend', sameOriginOnly);
resendRoutes.use(
  '/:token/resend',
  rateLimit('RL_REFRESH', (c) => `resend:${c.req.param('token')}`),
);
resendRoutes.post('/:token/resend', async (c) => {
  const token = c.req.param('token');
  const back = (state: 'sent' | 'wait' | 'none') => c.redirect(`/p/${token}?again=${state}`, 303);
  if (!isTokenShape(token)) return back('none');
  const ctx = svc(c);
  const pass = await passForToken(ctx, token).catch(() => null);
  if (!pass?.holderEmail || pass.status === 'voided' || pass.removedAt !== null)
    return back('none');
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
