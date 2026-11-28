import type { Hono } from 'hono';
import { platformIdentityRoutes } from './modules/identities/routes-platform.ts';
import { platformAppleRoutes } from './modules/identities/routes-wallet.ts';
import { platformInvitationRoutes } from './modules/idp/invitations/platform-routes.ts';
import { groupClaimsRoutes } from './modules/idp/routes-claims.ts';
import { idpGroupsRoutes } from './modules/idp/routes-groups.ts';
import { idpOperationRoutes } from './modules/idp/routes-ops.ts';
import { idpPlatformRoutes } from './modules/idp/routes-platform.ts';
import { idpSetupRoutes } from './modules/idp/routes-setup.ts';
import { orgClosedRoutes } from './modules/org-lifecycle/routes.ts';
import { platformEntitlementsRoutes } from './modules/orgs/routes-entitlements.ts';
import { platformPersonalLabelsRoutes } from './modules/orgs/routes-personal-labels.ts';
import { identityMoveRoutes } from './modules/passes/routes-identity-moves.ts';
import { retentionPlatformRoutes } from './modules/retention/routes.ts';
import { retentionPlatformReleaseRoutes } from './modules/retention/routes-platform-release.ts';
import { platformSettingsRoutes } from './modules/settings/routes-platform.ts';
import { walletPlatformRoutes } from './modules/wallet-providers/routes-platform-credentials.ts';
import type { AppBindings } from './platform/context.ts';

type Mount = readonly [path: string, routes: Hono<AppBindings>];

/**
 * Platform-admin API routes (`/api/v1/platform/*`). Mount order sets the order of the OpenAPI components, so the groups interleave with the
 * other files as listed in app.ts. Append a line to the group it belongs with.
 */
export const platformMounts: readonly (readonly Mount[])[] = [
  [
    // Platform routes that declare their own key access.
    ['/api/v1/platform', platformSettingsRoutes],
    ['/api/v1/platform', retentionPlatformReleaseRoutes],
    // Polaris ID routes declare their own key access (`{ platform, key? }`); a person-only one refuses a key with PERSON_REQUIRED.
    ['/api/v1/platform', idpOperationRoutes],
    ['/api/v1/platform', idpSetupRoutes],
    ['/api/v1/platform', idpPlatformRoutes],
    ['/api/v1/platform', idpGroupsRoutes],
    ['/api/v1/platform', platformInvitationRoutes],
    ['/api/v1/platform', groupClaimsRoutes],
    // Person-only: a key gets PERSON_REQUIRED.
    ['/api/v1/platform/apple/identities', platformIdentityRoutes],
    ['/api/v1/platform/apple/identity-moves', identityMoveRoutes],
    ['/api/v1/platform', walletPlatformRoutes],
    ['/api/v1/platform', platformEntitlementsRoutes],
    ['/api/v1/platform', platformPersonalLabelsRoutes],
    ['/api/v1/platform', retentionPlatformRoutes],
    ['/api/v1/platform', orgClosedRoutes],
  ],
  [['/api/v1/platform', platformAppleRoutes]],
];
