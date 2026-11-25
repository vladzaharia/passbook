import { PublicBundlePassParamSchema } from '../../../shared/contracts/bundles.ts';
import { passDevice } from '../../../shared/device.ts';
import { normalize } from '../../../shared/pass-view/index.ts';
import { stateWordOption } from '../../../shared/state-word.ts';
import { baseUrl } from '../../platform/env.ts';
import { AppError } from '../../platform/errors.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { requestTheme } from '../../ssr/head.ts';
import { renderNotFoundPage, renderPassPage } from '../../ssr/pass-page.tsx';
import { voidedAt } from '../events/repo-voided.ts';
import { orgBrandOf } from '../orgs/brand.ts';
import { svc } from '../passes/http.ts';
import { holderZone } from '../public/holder-zone.ts';
import { canPresent } from '../public/presentation.ts';
import { endedFor, langOf, PAGE_HEADERS } from '../public/routes.ts';
import { supportContacts } from '../public/service.ts';
import { walletIssuanceByProvider } from '../wallet-providers/provider-policy.ts';
import { assertBundleMember, bundleForToken, bundleMember, bundlePass } from './public-service.ts';
import { bundleWalletHref, bundleWalletProviders } from './wallet-links.ts';

/**
 * GET /b/:token/:passId: one member's page under the bundle's capability. Any state (an ended
 * member shows ended). Every link is the bundle's own and carries no member token. It has no print,
 * resend, sign-in or portal link, because those act on the member's own capability. A rotated or
 * revoked bundle makes it, and every file under it, a 404.
 */
export function registerMemberPage(router: ReturnType<typeof createRouter>) {
  register(
    router,
    'public',
    {
      method: 'get',
      path: '/{token}/{passId}',
      summary: 'One pass of the bundle (server-rendered HTML)',
      params: PublicBundlePassParamSchema,
    },
    async (c) => {
      const ctx = svc(c);
      const theme = requestTheme(c);
      try {
        const p = c.req.valid('param');
        const bundle = await bundleForToken(ctx, p.token);
        const pass = await bundlePass(ctx, bundle, p.passId);
        const { model } = await bundleMember(ctx, p.token, pass);
        const now = new Date(ctx.clock.now());
        const zone = await holderZone(ctx, pass.orgId);
        const lang = langOf(c.req.header('accept-language'));
        const view = normalize(model.passJson, {
          assets: model.assets,
          locale: lang,
          now,
          timeZone: zone,
          showZone: true,
          ...stateWordOption(pass),
        });
        const base = `/b/${p.token}/${pass.id}`;
        const live = canPresent(pass, model.passJson, ctx.clock.now()) && !model.removal;
        const providers = live ? await bundleWalletProviders(ctx, pass) : [];
        const html = renderPassPage({
          view,
          passJson: model.passJson,
          now,
          timeZone: zone,
          nonce: c.var.nonce,
          theme,
          orgName: view.organizationName || model.orgName,
          brand: await orgBrandOf(ctx, pass.orgId),
          orgLabel: model.orgName,
          passTitle: pass.displayTitle ?? view.description ?? model.orgName,
          downloadHref: live && model.channels.effective.apple.on ? `${base}/pass.pkpass` : null,
          barcodeHref: live && model.channels.effective.mobile.on ? `${base}/barcode` : undefined,
          channels: model.channels.effective,
          walletOffers: providers.map((provider) => ({
            provider,
            href: bundleWalletHref(p.token, pass.id, provider),
            installation: 'unknown' as const,
          })),
          issuance: walletIssuanceByProvider(pass.mode),
          publicUrl: `${baseUrl(c.env)}${base}`,
          backHref: `/b/${p.token}`,
          voided: pass.status === 'voided',
          removal: model.removal,
          mode: pass.mode,
          device: passDevice(c.req.header('user-agent')),
          support: await supportContacts(ctx, pass.orgId),
          endedOn: endedFor(
            view,
            pass,
            pass.status === 'voided' ? await voidedAt(ctx.env.DB, pass.orgId, pass.id) : null,
            model.passJson,
            zone,
            lang,
          ),
        });
        await assertBundleMember(ctx, bundle, pass);
        return new Response(html, { headers: PAGE_HEADERS });
      } catch (error) {
        if (error instanceof AppError && error.status === 404)
          return new Response(renderNotFoundPage(c.var.nonce, theme, { what: 'bundle' }), {
            status: 404,
            headers: PAGE_HEADERS,
          });
        throw error;
      }
    },
  );
}
