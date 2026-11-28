import type { Hono } from 'hono';
import { apiKeysRoutes } from './modules/api-keys/routes.ts';
import { apiKeyMeRoutes } from './modules/api-keys/routes-me.ts';
import { auditRoutes } from './modules/audit/routes.ts';
import { authRoutes, sessionRoutes } from './modules/auth/routes.ts';
import { broadcastsRoutes } from './modules/broadcasts/routes.ts';
import { bundlesRoutes } from './modules/bundles/routes.ts';
import { connectionsRoutes, connectorsRoutes } from './modules/connections/routes.ts';
import { deliveryRoutes } from './modules/delivery/routes.ts';
import { developerOrgRoutes } from './modules/dev-access/routes-org.ts';
import { developerRoutes } from './modules/developer/routes.ts';
import { holdersRoutes } from './modules/holders/routes.ts';
import { offboardRoutes } from './modules/holders/routes-offboard.ts';
import { identitiesRoutes } from './modules/identities/routes.ts';
import { identityRevokeRoutes } from './modules/identities/routes-revoke.ts';
import { identityProvisionRoutes, identityRunsRoutes } from './modules/identities/routes-runs.ts';
import { walletIdentitiesRoutes } from './modules/identities/routes-wallet.ts';
import { invitationRoutes } from './modules/idp/invitations/routes.ts';
import { userClaimsRoutes } from './modules/idp/routes-claims.ts';
import { userHoldRoutes } from './modules/idp/routes-ops.ts';
import { userAccessRoutes } from './modules/idp/routes-users.ts';
import { joinLinksRoutes } from './modules/join/routes-admin.ts';
import { meRoutes } from './modules/me/routes.ts';
import { messageRulesRoutes } from './modules/message-rules/routes.ts';
import { metricsRoutes } from './modules/metrics/routes.ts';
import { metricsPlatformRoutes } from './modules/metrics/routes-platform.ts';
import { nfcRoutes } from './modules/nfc/routes.ts';
import { operationsRoutes } from './modules/operations/routes.ts';
import { orgExportDownloadRoutes, orgLifecycleRoutes } from './modules/org-lifecycle/routes.ts';
import { brandRoutes } from './modules/orgs/brand-routes.ts';
import { passSetupRoutes } from './modules/orgs/pass-setup-routes.ts';
import { passSetupWriteRoutes } from './modules/orgs/pass-setup-write-routes.ts';
import { orgsRoutes } from './modules/orgs/routes.ts';
import { orgEntitlementsRoutes } from './modules/orgs/routes-entitlements.ts';
import { passesRoutes } from './modules/passes/routes.ts';
import { passImportRoutes } from './modules/passes/routes-import.ts';
import { retentionRoutes } from './modules/retention/routes.ts';
import { sandboxRoutes } from './modules/sandbox/routes.ts';
import { rollCallRoutes } from './modules/scan/roll-call/routes-api.ts';
import { scanRoutes } from './modules/scan/routes.ts';
import { scanDisplayRoutes } from './modules/scan/routes-display.ts';
import { scanEventsRoutes } from './modules/scan/routes-events.ts';
import { scanLiveRoutes } from './modules/scan/routes-live.ts';
import { scanPairRoutes } from './modules/scan/routes-pair.ts';
import { scannersRoutes } from './modules/scan/routes-scanners.ts';
import { scanningSessionsRoutes } from './modules/scan/routes-scanning-sessions.ts';
import { scansRoutes } from './modules/scan/routes-scans.ts';
import { scanSetupsRoutes } from './modules/scan/routes-setups.ts';
import { scanStaffRoutes } from './modules/scan/routes-staff.ts';
import { scanZonesRoutes } from './modules/scan/routes-zones.ts';
import { settingsRoutes } from './modules/settings/routes.ts';
import { statusRoutes } from './modules/status/routes.ts';
import { templatesRoutes } from './modules/templates/routes.ts';
import { templateReviewsRoutes } from './modules/templates/routes-reviews.ts';
import { usersRoutes } from './modules/users/routes.ts';
import { walletProviderAccountRoutes } from './modules/wallet-providers/routes-accounts.ts';
import { walletCredentialRoutes } from './modules/wallet-providers/routes-credentials.ts';
import { walletEnrolmentRoutes } from './modules/wallet-providers/routes-enrolments.ts';
import { walletReissueRoutes } from './modules/wallet-providers/routes-reissue.ts';
import { walletProviderStatusRoutes } from './modules/wallet-providers/routes-status.ts';
import { webhookEndpointsRoutes } from './modules/webhooks/routes.ts';
import { eventFeedRoutes } from './modules/webhooks/routes-feed.ts';
import { workbenchRoutes } from './modules/workbench/routes.ts';
import { requestLogRoutes } from './modules/workbench/routes-logs.ts';
import { resolveRoutes, workbenchReadRoutes } from './modules/workbench/routes-read.ts';
import type { AppBindings } from './platform/context.ts';

type Mount = readonly [path: string, routes: Hono<AppBindings>];

/**
 * Session-or-key API routes. Mount order sets the order of the OpenAPI components, so the groups interleave with the
 * other files as listed in app.ts. Append a line to the group it belongs with.
 */
export const tenantMounts: readonly (readonly Mount[])[] = [
  [
    ['/auth', authRoutes],
    ['/api/v1/session', sessionRoutes],
    ['/api/v1/me', meRoutes],
    ['/api/v1/developer', developerRoutes],
    ['/api/v1/workbench', workbenchRoutes],
    ['/api/v1', resolveRoutes],
    ['/api/v1/workbench', workbenchReadRoutes],
    ['/api/v1/request-logs', requestLogRoutes],
    // Ahead of orgsRoutes, whose session-only guard would turn a key away from the read.
    ['/api/v1/orgs', orgEntitlementsRoutes],
    ['/api/v1/orgs', developerOrgRoutes],
    ['/api/v1/invitations', invitationRoutes],
    ['/api/v1/orgs', passSetupRoutes],
    ['/api/v1/orgs', passSetupWriteRoutes],
    ['/api/v1/orgs', orgsRoutes],
    ['/api/v1/brand', brandRoutes],
    ['/api/v1/orgs', walletCredentialRoutes],
    ['/api/v1/orgs', walletEnrolmentRoutes],
    ['/api/v1/orgs', retentionRoutes],
    ['/api/v1/orgs', orgLifecycleRoutes],
    ['/api/v1/org-exports', orgExportDownloadRoutes],
  ],
  [
    ['/api/v1/templates', templatesRoutes],
    ['/api/v1/template-reviews', templateReviewsRoutes],
    ['/api/v1/operations', operationsRoutes],
    ['/api/v1/passes', passesRoutes],
    ['/api/v1/pass-imports', passImportRoutes],
    ['/api/v1/bundles', bundlesRoutes],
    ['/api/v1/join-links', joinLinksRoutes],
    ['/api/v1/test-inbox', sandboxRoutes],
    ['/api/v1/broadcasts', broadcastsRoutes],
    ['/api/v1/message-rules', messageRulesRoutes],
    ['/api/v1/holders', holdersRoutes],
    ['/api/v1/offboard', offboardRoutes],
    ['/api/v1/delivery', deliveryRoutes],
    ['/api/v1/connections', connectionsRoutes],
    ['/api/v1/connectors', connectorsRoutes],
    ['/api/v1/webhook-endpoints', webhookEndpointsRoutes],
    ['/api/v1/events', eventFeedRoutes],
    ['/api/v1/identities', identityRevokeRoutes],
    ['/api/v1/identities', identitiesRoutes],
    ['/api/v1/identity-runs', identityRunsRoutes],
    ['/api/v1/wallet-identities', walletIdentitiesRoutes],
    ['/api/v1/orgs', identityProvisionRoutes],
  ],
  [
    ['/api/v1/wallet-providers/accounts', walletProviderAccountRoutes],
    ['/api/v1/wallet-providers/passes', walletProviderStatusRoutes],
    ['/api/v1/wallet-providers/reissue', walletReissueRoutes],
    // Before usersRoutes: its admin-session guard would otherwise run first on `/{id}/claims`.
    ['/api/v1/users', userClaimsRoutes],
    ['/api/v1/users', userHoldRoutes],
    ['/api/v1/users', userAccessRoutes],
    ['/api/v1/users', usersRoutes],
    ['/api/v1/api-keys/me', apiKeyMeRoutes],
    ['/api/v1/api-keys', apiKeysRoutes],
    ['/api/v1/settings', settingsRoutes],
    ['/api/v1/audit', auditRoutes],
    ['/api/v1/status', statusRoutes],
    ['/api/v1/metrics', metricsPlatformRoutes],
    ['/api/v1/metrics', metricsRoutes],
    ['/api/v1/scan', scanPairRoutes],
    ['/api/v1/scan', scanRoutes],
    ['/api/v1/scanners', scannersRoutes],
    ['/api/v1/scan-setups', scanSetupsRoutes],
    ['/api/v1/scanning-sessions', scanningSessionsRoutes],
    ['/api/v1/scan/live', scanLiveRoutes],
    ['/api/v1/scan-events', scanEventsRoutes],
    ['/api/v1/scan-staff', scanStaffRoutes],
    ['/api/v1/scan-zones', scanZonesRoutes],
    ['/api/v1/scans', scansRoutes],
    ['/api/v1/roll-calls', rollCallRoutes],
    ['/api/v1/scan-display', scanDisplayRoutes],
    ['/api/v1/nfc', nfcRoutes],
  ],
];
