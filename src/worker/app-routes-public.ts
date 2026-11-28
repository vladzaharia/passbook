import type { Hono } from 'hono';
import { appleRoutes } from './modules/apple/routes.ts';
import { bundlePublicRoutes } from './modules/bundles/public-routes.ts';
import { developerPortalRoutes } from './modules/developer/portal.ts';
import { joinPublicRoutes } from './modules/join/routes-public.ts';
import { marketingRoutes } from './modules/marketing/routes.ts';
import { marketingPageRoutes } from './modules/marketing/routes-pages.ts';
import { tagPageRoutes } from './modules/nfc/tag-page.ts';
import { brandAssetRoutes } from './modules/orgs/brand-assets.ts';
import { publicRoutes } from './modules/public/routes.ts';
import { previewRoutes } from './modules/public/routes-preview.ts';
import { scanShellSwRoutes } from './modules/scan/routes-shell-sw.ts';
import { walletImageRoutes } from './modules/wallet-providers/routes-assets.ts';
import { samsungCallbackRoutes } from './modules/wallet-providers/routes-callbacks.ts';
import { googleCallbackRoutes } from './modules/wallet-providers/routes-google-callbacks.ts';
import { walletOfferRoutes } from './modules/wallet-providers/routes-offers.ts';
import type { AppBindings } from './platform/context.ts';

type Mount = readonly [path: string, routes: Hono<AppBindings>];

/**
 * Unauthenticated and holder-facing pages; the marketing catch-all stays last. Mount order sets the order of the OpenAPI components, so the groups interleave with the
 * other files as listed in app.ts. Append a line to the group it belongs with.
 */
export const publicMounts: readonly (readonly Mount[])[] = [
  [
    ['/t', tagPageRoutes],
    ['/wallet/v1/google', googleCallbackRoutes],
    ['/wallet/v1/samsung', samsungCallbackRoutes],
    ['/wallet/v1', appleRoutes],
    ['/scan', scanShellSwRoutes],
    ['/p', walletOfferRoutes],
    ['/w/i', walletImageRoutes],
    ['/brand', brandAssetRoutes],
    ['/p', publicRoutes],
    ['/preview', previewRoutes],
    ['/b', bundlePublicRoutes],
    ['/j', joinPublicRoutes],
  ],
  [
    ['/developers', developerPortalRoutes],
    ['/access', marketingRoutes],
    ['/', marketingPageRoutes],
  ],
];
