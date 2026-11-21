import { sameOriginOnly } from '../../platform/csrf.ts';
import { createRouter } from '../../platform/openapi.ts';
import { ASSET_MISSES_PER_MINUTE, gateMisses, rateLimit } from '../../platform/rate-limit.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { isEmailSignInEnabled } from '../auth/magic-service.ts';
import { isPreviewOnlyOrg } from '../developer/fence.ts';
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
  rateLimit('RL_REFRESH', (c) => `resend:${c.req.param('token')}`),
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

const stateOf = (v: string | undefined): 'sent' | 'wait' | null =>
  v === 'sent' || v === 'wait' ? v : null;

/**
 * What the pass page needs for the two holder mails: Send it again (live) and Email me my passes.
 * No sign-in action for a test-mode or developer-org pass, or while email sign-in is off: the
 * route sends nothing then, so the card must not promise it.
 */
export async function holderMailProps(
  ctx: ServiceContext,
  page: string,
  pass: { holderEmail: string | null; mode: string; orgId: string },
  removed: boolean,
  query: (name: string) => string | undefined,
) {
  if (!pass.holderEmail) return {};
  const signin =
    pass.mode !== 'test' &&
    !(await isPreviewOnlyOrg(ctx.env.DB, pass.orgId)) &&
    (await isEmailSignInEnabled(ctx));
  return {
    ...(removed ? {} : { resend: { action: `${page}/resend`, again: stateOf(query('again')) } }),
    ...(signin ? { signin: { action: `${page}/sign-in`, state: stateOf(query('signin')) } } : {}),
  };
}
