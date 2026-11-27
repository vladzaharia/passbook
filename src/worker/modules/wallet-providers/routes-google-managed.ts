import {
  CompleteGoogleManagedIssuerSchema,
  GoogleIssuerRunSchema,
  GoogleManagedIssuerRequestSchema,
  GoogleManagedOrgParamsSchema,
  GoogleManagedStatusSchema,
  GoogleSharedIssuerInfoSchema,
  GoogleSharedIssuerSchema,
  ShareGoogleIssuerSchema,
  WalletCredentialIdParamsSchema,
  WalletCredentialKeyRotationSchema,
} from '../../../shared/contracts/wallet-providers.ts';
import { platformActorOf } from '../../platform/actor.ts';
import { UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { STEP_UP_SECONDS } from '../../platform/sign-in-guard.ts';
import { byUserOf } from '../idp/actor.ts';
import { authOf } from '../passes/http.ts';
import { managedIssuerStatus, requestManagedIssuer } from './google-managed-service.ts';
import { completeManualIssuer, startManagedIssuer } from './issuer-provision.ts';
import { startKeyRotation } from './sa-key-rotation.ts';
import { sharedIssuerInfo, shareGoogleIssuer } from './shared-issuer.ts';

const sessionOf = (c: Parameters<typeof authOf>[0]) => {
  const auth = authOf(c);
  if (auth.kind !== 'session') throw new UnauthenticatedError();
  return auth;
};

/** The person recorded as creator (a key's is the person who minted it), and the key that acted, if any. */
const issuerBy = async (c: Parameters<typeof platformActorOf>[0]) => {
  const by = platformActorOf(c, { scope: 'platform:wallet' });
  return { createdBy: await byUserOf(c.env.DB, by), keyId: by.keyId };
};
const keyOf = ({ keyId }: { keyId: string | null }) => (keyId ? { keyId } : {});

/** Mounted inside the org wallet routes (`/api/v1/orgs`, tenant session). */
export const googleManagedOrgRoutes = createRouter();

register(
  googleManagedOrgRoutes,
  'wallet credentials',
  {
    method: 'post',
    path: '/{orgId}/wallet-accounts/google/managed',
    summary: 'Ask PassBook for a managed Google issuer',
    params: GoogleManagedOrgParamsSchema,
    body: GoogleManagedIssuerRequestSchema,
    response: GoogleIssuerRunSchema,
    status: 202,
    xFeature: 'identity.managed',
  },
  async (c) =>
    c.json(
      await requestManagedIssuer(serviceContext(c), sessionOf(c), c.req.valid('param').orgId),
      202,
    ),
);

register(
  googleManagedOrgRoutes,
  'wallet credentials',
  {
    method: 'get',
    path: '/{orgId}/wallet-accounts/google/managed',
    summary: 'Read the latest managed Google issuer run',
    params: GoogleManagedOrgParamsSchema,
    response: GoogleManagedStatusSchema,
  },
  async (c) =>
    c.json(await managedIssuerStatus(serviceContext(c), sessionOf(c), c.req.valid('param').orgId)),
);

register(
  googleManagedOrgRoutes,
  'wallet credentials',
  {
    method: 'post',
    path: '/{orgId}/wallet-accounts/google/shared',
    summary: "Connect your Google issuer through PassBook's service account",
    params: GoogleManagedOrgParamsSchema,
    body: ShareGoogleIssuerSchema,
    response: GoogleSharedIssuerSchema,
  },
  async (c) =>
    c.json(
      await shareGoogleIssuer(
        serviceContext(c),
        sessionOf(c),
        c.req.valid('param').orgId,
        c.req.valid('json').issuerId,
      ),
    ),
);

register(
  googleManagedOrgRoutes,
  'wallet credentials',
  {
    method: 'get',
    path: '/{orgId}/wallet-accounts/google/shared',
    summary: "Read PassBook's service-account address for sharing an issuer",
    params: GoogleManagedOrgParamsSchema,
    response: GoogleSharedIssuerInfoSchema,
  },
  async (c) =>
    c.json(await sharedIssuerInfo(serviceContext(c), sessionOf(c), c.req.valid('param').orgId)),
);

/** Mounted inside the platform wallet routes (`/api/v1/platform`); each route declares its own access. */
export const googleManagedPlatformRoutes = createRouter();

register(
  googleManagedPlatformRoutes,
  'wallet platform',
  {
    method: 'post',
    auth: { platform: 'platform:wallet', key: true },
    path: '/orgs/{orgId}/wallet-accounts/google/managed',
    summary: 'Start a managed Google issuer for an organization',
    params: GoogleManagedOrgParamsSchema,
    body: GoogleManagedIssuerRequestSchema,
    response: GoogleIssuerRunSchema,
    status: 202,
  },
  async (c) => {
    const by = await issuerBy(c);
    return c.json(
      (
        await startManagedIssuer(serviceContext(c), {
          orgId: c.req.valid('param').orgId,
          createdBy: by.createdBy,
          ...keyOf(by),
        })
      ).run,
      202,
    );
  },
);

register(
  googleManagedPlatformRoutes,
  'wallet platform',
  {
    method: 'post',
    auth: { platform: 'platform:wallet', key: true },
    path: '/orgs/{orgId}/wallet-accounts/google/managed/complete',
    summary: 'Finish a parked managed Google issuer with an issuer id made in the console',
    params: GoogleManagedOrgParamsSchema,
    body: CompleteGoogleManagedIssuerSchema,
    response: GoogleIssuerRunSchema,
    status: 202,
  },
  async (c) => {
    const by = await issuerBy(c);
    return c.json(
      await completeManualIssuer(serviceContext(c), {
        orgId: c.req.valid('param').orgId,
        issuerId: c.req.valid('json').issuerId,
        adminId: by.createdBy,
        ...keyOf(by),
      }),
      202,
    );
  },
);

register(
  googleManagedPlatformRoutes,
  'wallet platform',
  {
    method: 'post',
    // Rotating a service-account key replaces what signs for Google Wallet: a recent sign-in.
    auth: { platform: 'platform:wallet', key: true, stepUp: { maxAgeSec: STEP_UP_SECONDS } },
    path: '/wallet-credentials/{id}/rotate-key',
    summary: "Rotate a platform Google credential's service-account key now",
    params: WalletCredentialIdParamsSchema,
    response: WalletCredentialKeyRotationSchema,
    status: 202,
  },
  async (c) => {
    const by = await issuerBy(c);
    const { runId } = await startKeyRotation(serviceContext(c), {
      credentialId: c.req.valid('param').id,
      createdBy: by.createdBy,
    });
    return c.json({ runId }, 202);
  },
);
