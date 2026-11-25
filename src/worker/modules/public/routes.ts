import { PublicAssetParamSchema, PublicTokenParamSchema } from '../../../shared/contracts/index.ts';
import { passDevice } from '../../../shared/device.ts';
import { formatEndedOn } from '../../../shared/format-date.ts';
import { normalize } from '../../../shared/pass-view/index.ts';
import { stateWordOption } from '../../../shared/state-word.ts';
import { DEFAULT_TIME_ZONE } from '../../../shared/time-zone.ts';
import { writeEvent } from '../../platform/analytics.ts';
import { baseUrl } from '../../platform/env.ts';
import { AppError } from '../../platform/errors.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import {
  ASSET_MISSES_PER_MINUTE,
  assetBucket,
  gateMisses,
  rateLimit,
} from '../../platform/rate-limit.ts';
import { requestTheme } from '../../ssr/head.ts';
import { renderNotFoundPage, renderPassPage } from '../../ssr/pass-page.tsx';
import {
  PRESENTATION_HEADERS,
  presentationHeaders,
  renderPresentationPage,
} from '../../ssr/presentation-page.tsx';
import { appleFileGate, recordCopy } from '../channels/gate.ts';
import { codesReplacedNotice } from '../channels/service.ts';
import { recordPassEvent } from '../events/record.ts';
import { voidedAt } from '../events/repo-voided.ts';
import { orgBrandOf } from '../orgs/brand.ts';
import { servePassFile } from '../passes/file.ts';
import { type C, svc } from '../passes/http.ts';
import { holderPrintRoutes } from '../prints/routes-holder.ts';
import { listWalletOffers } from '../wallet-providers/offers.ts';
import { walletIssuanceByProvider } from '../wallet-providers/provider-policy.ts';
import { canPresent, presentationForPass } from './presentation.ts';
import { holderMailProps, resendRoutes } from './routes-resend.ts';
import { signInRoutes } from './routes-signin.ts';
import { swRoutes } from './routes-sw.ts';
import {
  isTokenShape,
  openPublicAsset,
  pageModel,
  passForToken,
  supportContacts,
} from './service.ts';
import { assertPassSnapshot, capturePassSnapshot } from './snapshot.ts';

/** /p: bearer-link pass page and download. No sign-in. */
export const publicRoutes = createRouter();
// Registered first, so the /:token limits below never see /sw.js.
publicRoutes.route('/', swRoutes);
// Mail proxies fetch every emailed pass's images from a few IPs, so valid assets are limited per
// token and network prefix only. Random tokens each get a fresh per-token bucket, so a prefix's
// misses are counted and, past a threshold, refused before any lookup.
publicRoutes.use('/:token/assets/*', gateMisses(ASSET_MISSES_PER_MINUTE));
publicRoutes.use(
  '/:token/assets/*',
  rateLimit('RL_PUBLIC_ASSET', (c) => assetBucket(c, isTokenShape)),
);
publicRoutes.use('/:token', rateLimit('RL_PUBLIC'));
publicRoutes.use('/:token/pass.pkpass', rateLimit('RL_PUBLIC'));
publicRoutes.use('/:token/barcode', rateLimit('RL_PUBLIC'));

publicRoutes.route('/', resendRoutes);
publicRoutes.route('/', signInRoutes);
publicRoutes.route('/', holderPrintRoutes);

export function endedFor(
  view: { voided: boolean; expired: boolean },
  pass: { status: string; modifiedAt: number },
  voidedAt: number | null,
  passJson: { expirationDate?: unknown },
  zone: string | undefined,
  lang: string,
): string | null {
  const state =
    pass.status === 'voided' || view.voided ? 'voided' : view.expired ? 'expired' : null;
  return state
    ? formatEndedOn(
        state,
        { modifiedAt: pass.modifiedAt, voidedAt, expirationDate: passJson.expirationDate },
        zone,
        lang,
      )
    : null;
}

export const EMAILED = /^(icon|logo)(@[23]x)?\.png$/;

export const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'private, no-store',
  'x-robots-tag': 'noindex, nofollow',
};

/** Formatting locale for dates and numbers on the card; the page copy stays English. */
export const langOf = (header: string | undefined): string => {
  const tag = header?.split(',')[0]?.split(';')[0]?.trim();
  return tag && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(tag) ? tag : 'en';
};

/** Visitor zone from Cloudflare, if it is a zone Intl knows. */
export function zoneOf(c: C): string | undefined {
  const tz = c.req.raw.cf?.timezone;
  if (typeof tz !== 'string' || !tz) return undefined;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

register(
  publicRoutes,
  'public',
  {
    method: 'get',
    path: '/{token}',
    summary: 'Pass page (server-rendered HTML)',
    params: PublicTokenParamSchema,
  },
  async (c) => {
    const svcCtx = svc(c);
    const theme = requestTheme(c);
    try {
      const { token } = c.req.valid('param');
      const pass = await passForToken(svcCtx, token);
      const snapshot = await capturePassSnapshot(svcCtx, pass);
      const model = await pageModel(svcCtx, pass);
      const page = `/p/${token}`;
      const notice = model.removal ? undefined : await codesReplacedNotice(svcCtx, pass);
      // Resolve only links to this bearer under the same snapshot as the page and its assets.
      const walletOffers = canPresent(pass, model.passJson, svcCtx.clock.now())
        ? (await listWalletOffers(svcCtx, pass.id, model.channels.effective))
            .filter(({ provider, href }) => href === `${page}/wallet/${provider}`)
            .map(({ provider, href }) => ({ provider, href, installation: 'unknown' as const }))
        : [];
      const lang = langOf(c.req.header('accept-language'));
      const view = normalize(model.passJson, {
        assets: model.assets,
        locale: lang,
        now: new Date(svcCtx.clock.now()),
        timeZone: zoneOf(c) ?? DEFAULT_TIME_ZONE,
        ...stateWordOption(pass),
      });
      const html = renderPassPage({
        view,
        passJson: model.passJson,
        now: new Date(svcCtx.clock.now()),
        ...(zoneOf(c) ? { timeZone: zoneOf(c) as string } : {}),
        nonce: c.var.nonce,
        theme,
        orgName: view.organizationName || model.orgName,
        brand: await orgBrandOf(svcCtx, pass.orgId),
        orgLabel: model.orgName,
        passTitle: pass.displayTitle ?? view.description ?? model.orgName,
        downloadHref: model.channels.effective.apple.on ? `${page}/pass.pkpass` : null,
        barcodeHref: model.channels.effective.mobile.on ? `${page}/barcode` : undefined,
        channels: model.channels.effective,
        ...(model.channels.holderPrint ? { printHref: `${page}/print` } : {}),
        walletOffers,
        issuance: walletIssuanceByProvider(pass.mode),
        // The add QR opens this page on the phone, where the badge adds the pass.
        publicUrl: `${baseUrl(c.env)}${page}`,
        portalHref: `/passes/${pass.id}`,
        voided: pass.status === 'voided',
        removal: model.removal,
        mode: pass.mode,
        device: passDevice(c.req.header('user-agent')),
        support: await supportContacts(svcCtx, pass.orgId),
        endedOn: endedFor(
          view,
          pass,
          pass.status === 'voided' ? await voidedAt(svcCtx.env.DB, pass.orgId, pass.id) : null,
          model.passJson,
          zoneOf(c),
          lang,
        ),
        ...(notice ? { notice } : {}),
        ...(await holderMailProps(svcCtx, page, pass, Boolean(model.removal), (name) =>
          c.req.query(name),
        )),
      });
      await assertPassSnapshot(svcCtx, snapshot);
      svcCtx.waitUntil(
        recordPassEvent(svcCtx, {
          orgId: pass.orgId,
          passId: pass.id,
          mode: pass.mode,
          kind: 'page.opened',
          actor: { type: 'holder', id: null },
        }),
      );
      return new Response(html, { headers: PAGE_HEADERS });
    } catch (error) {
      if (error instanceof AppError && error.status === 404)
        return new Response(renderNotFoundPage(c.var.nonce, theme, { drop: true }), {
          status: 404,
          headers: PAGE_HEADERS,
        });
      throw error;
    }
  },
);

register(
  publicRoutes,
  'public',
  {
    method: 'get',
    path: '/{token}/barcode',
    summary: 'Present this pass barcode',
    params: PublicTokenParamSchema,
  },
  async (c) => {
    const ctx = svc(c);
    const theme = requestTheme(c);
    try {
      const { token } = c.req.valid('param');
      const pass = await passForToken(ctx, token);
      const snapshot = await capturePassSnapshot(ctx, pass);
      const model = await presentationForPass(ctx, pass);
      const html = renderPresentationPage({
        ...model,
        backHref: `/p/${token}`,
        offline: true,
        nonce: c.var.nonce,
        theme,
      });
      await assertPassSnapshot(ctx, snapshot);
      ctx.waitUntil(recordCopy(ctx, pass, 'mobile'));
      return new Response(html, { headers: presentationHeaders(model.expiresAt) });
    } catch (error) {
      if (error instanceof AppError && error.status === 404) {
        return new Response(renderNotFoundPage(c.var.nonce, theme, { replay: false, drop: true }), {
          status: 404,
          headers: PRESENTATION_HEADERS,
        });
      }
      throw error;
    }
  },
);

register(
  publicRoutes,
  'public',
  {
    method: 'get',
    path: '/{token}/pass.pkpass',
    summary: 'Download the pass',
    params: PublicTokenParamSchema,
  },
  async (c) => {
    const ctx = svc(c);
    const pass = await passForToken(ctx, c.req.valid('param').token);
    // Gate before the snapshot: a flip landing between them serves one live copy, and the version
    // bump it causes trips the snapshot check below.
    await appleFileGate(ctx, pass);
    const snapshot = await capturePassSnapshot(ctx, pass);
    const response = await servePassFile(c.env.BUCKET, pass, c.req.raw);
    try {
      await assertPassSnapshot(ctx, snapshot);
    } catch (error) {
      await response.body?.cancel();
      throw error;
    }
    if (response.status === 200) {
      await recordCopy(ctx, pass, 'apple');
      writeEvent(c.env, {
        event: 'pass.downloaded',
        orgId: pass.orgId,
        templateId: pass.templateId,
        identityId: pass.identityId,
        mode: pass.mode,
      });
      await recordPassEvent(svc(c), {
        orgId: pass.orgId,
        passId: pass.id,
        mode: pass.mode,
        kind: 'pass.downloaded',
        actor: { type: 'holder', id: null },
      });
    }
    try {
      await assertPassSnapshot(ctx, snapshot);
    } catch (error) {
      await response.body?.cancel();
      throw error;
    }
    return response;
  },
);

register(
  publicRoutes,
  'public',
  {
    method: 'get',
    path: '/{token}/assets/{name}',
    summary: 'Pass image',
    params: PublicAssetParamSchema,
  },
  async (c) => {
    const p = c.req.valid('param');
    const ctx = svc(c);
    const pass = await passForToken(ctx, p.token);
    const snapshot = await capturePassSnapshot(ctx, pass);
    const asset = await openPublicAsset(ctx, pass, p.name);
    try {
      await assertPassSnapshot(ctx, snapshot);
    } catch (error) {
      await asset.body.cancel();
      throw error;
    }
    const headers = {
      'content-type': 'image/png',
      etag: asset.etag,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      // The pass email shows the icon and logo, and webmail loads them from its own origin.
      ...(EMAILED.test(p.name) ? { 'cross-origin-resource-policy': 'cross-origin' } : {}),
    };
    if (c.req.header('if-none-match') === asset.etag) {
      await asset.body.cancel();
      return new Response(null, { status: 304, headers });
    }
    return new Response(asset.body, { headers });
  },
);
