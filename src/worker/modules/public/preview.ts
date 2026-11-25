import type { PassJson } from '../../../passkit/types.ts';
import { toSvg } from '../../../shared/pass-view/barcode-svg.ts';
import { normalize } from '../../../shared/pass-view/index.ts';
import { stateWordOption } from '../../../shared/state-word.ts';
import { compileWallets } from '../../../web/channel-previews/wallet-kit.ts';
import { drawPaperCode } from '../../../web/paper/drawing.ts';
import { baseUrl } from '../../platform/env.ts';
import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { PreviewPageProps } from '../../ssr/preview-page.tsx';
import { isPreviewOnlyOrg } from '../developer/fence.ts';
import { checkPreviewLink, type PreviewTarget } from '../developer/preview-link.ts';
import { orgBrandOf } from '../orgs/brand.ts';
import { resolveTemplate } from '../passes/builder.ts';
import { depsOf } from '../passes/deps.ts';
import type { Pass } from '../passes/repo-map.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { paperTicket } from '../prints/paper.ts';
import { readOrgTimeZone } from '../scan/repo-org-clock.ts';
import { getOrgSettings } from '../settings/service.ts';
import { currentPublicGeneration } from './repo.ts';
import { openPublicAsset, type PublicAsset, pageModel } from './service.ts';

/** A code of the print code's shape, so the sheet draws a real QR; never a real ticket's. */
const SAMPLE_CODE = 'PSAMPLEABCDEFGHIJKLMNOPQRST';

export type PreviewResult =
  | { state: 'ok'; page: Omit<PreviewPageProps, 'nonce' | 'theme'> }
  | { state: 'expired' | 'missing' };

/**
 * The pass a checked link opens: a test pass of a developer org, still on the link generation the link was
 * made under (a rotated pass link is a new generation and retires every older preview link).
 */
export async function passOfPreview(
  ctx: ServiceContext,
  link: PreviewTarget,
): Promise<Pass | null> {
  const pass = await getPass(ctx.env.DB, link.passId);
  if (
    !pass ||
    pass.linkGeneration !== link.linkGeneration ||
    pass.mode !== 'test' ||
    !(await isPreviewOnlyOrg(ctx.env.DB, pass.orgId)) ||
    !(await currentPublicGeneration(ctx.env.DB, pass))
  )
    return null;
  return pass;
}

/**
 * The TEST preview of a sandbox pass from its link: the Apple card, the Google and Samsung cards
 * the real compilers make, and the ticket as it prints. A bad link, a rotated one, a live pass or a
 * pass outside a developer org is `missing`; only a genuine link past its 30 days is `expired`.
 * Images load under the link, so the page never carries the pass's own link token.
 */
export async function previewFor(
  ctx: ServiceContext,
  link: string,
  locale: string,
): Promise<PreviewResult> {
  const checked = await checkPreviewLink(ctx.env, link, ctx.clock.now());
  if (checked.state !== 'ok') return { state: checked.state === 'expired' ? 'expired' : 'missing' };
  const pass = await passOfPreview(ctx, checked);
  if (!pass) return { state: 'missing' };
  const [model, template, ticket] = await Promise.all([
    pageModel(ctx, pass),
    resolveTemplate(ctx, pass.orgId, pass.templateId, pass.templateVersion),
    paperTicket(ctx, pass, 'holder'),
  ]);
  const { mark } = await orgBrandOf(ctx, pass.orgId);
  const base = baseUrl(ctx.env);
  const website = (await getOrgSettings(ctx, pass.orgId))['org.website'];
  const assetBase = `/preview/${link}/assets/`;
  const assets = Object.fromEntries(
    Object.entries(model.assets).map(([name, path]) => [
      name,
      path.replace(/^\/p\/[^/]+\/assets\//, assetBase),
    ]),
  );
  const now = new Date(ctx.clock.now());
  const zone = await readOrgTimeZone(ctx.env.DB, pass.orgId);
  const view = normalize(model.passJson as PassJson, {
    assets,
    locale,
    now,
    timeZone: zone,
    showZone: true,
    ...stateWordOption(pass),
  });
  let wallets: PreviewPageProps['wallets'] = null;
  try {
    wallets = compileWallets(
      {
        passJson: model.passJson as unknown as Record<string, unknown>,
        assetBaseUrl: `${base}${assetBase}`,
        assetNames: Object.keys(assets),
        manifest: template.manifest as unknown as Record<string, unknown>,
        assets: template.assets,
        input: pass.personalization,
        testBand: true,
      },
      { origin: base, now, timeZone: zone, ...(website ? { website } : {}) },
    );
  } catch {
    // A pass a compiler cannot read still shows the Apple card and the ticket.
    ctx.log.warn('preview.wallets_failed', { orgId: pass.orgId, code: 'PREVIEW_WALLETS' });
  }
  const file = (name: string | undefined) =>
    name ? (assets[name] ?? `${assetBase}${name}`) : undefined;
  return {
    state: 'ok',
    page: {
      view,
      wallets,
      paper: ticket
        ? {
            content: ticket.content,
            design: ticket.design,
            drawing: drawPaperCode(toSvg, ticket.design.barcode, SAMPLE_CODE),
            mark,
            assets: { logo: file(ticket.files.logo), art: file(ticket.files.art) },
          }
        : null,
      passTitle: pass.displayTitle ?? view.description ?? model.orgName,
    },
  };
}

/** A wallet's own art in the template (`wallets/google/logo.png`): the page shows it as that wallet will. */
const WALLET_ART = /^wallets\/(?:google|samsung)\/[A-Za-z0-9_@.-]{1,80}\.png$/;

/** An image of the previewed pass: the pass page's own rules, plus the template's wallet art. */
export async function previewAsset(
  ctx: ServiceContext,
  pass: Pass,
  name: string,
): Promise<PublicAsset> {
  if (!WALLET_ART.test(name)) return openPublicAsset(ctx, pass, name);
  const template = await resolveTemplate(ctx, pass.orgId, pass.templateId, pass.templateVersion);
  const entry = template.assets.find((a) => a.name === name);
  if (!entry) throw new NotFoundError('Image not found.', 'ASSET_NOT_FOUND');
  return {
    body: await depsOf(ctx.env).registry.openAsset(template, name),
    etag: `"${entry.sha1 || `${template.version}-${name}`}"`,
  };
}
