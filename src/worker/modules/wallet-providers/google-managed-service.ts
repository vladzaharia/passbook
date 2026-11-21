import type { GoogleIssuerRun } from '../../../shared/contracts/wallet-providers.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { requireEntitled } from '../../platform/entitlements.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { latestManagedRun, startManagedIssuer } from './issuer-provision.ts';

function sessionOf(auth: SessionAuth): SessionAuth {
  if (auth?.kind !== 'session') throw new ForbiddenError();
  return auth;
}

/** An org owner asks for a managed issuer: a live session, `integrations:manage`, and the `identity.managed` plan. */
export async function requestManagedIssuer(
  ctx: ServiceContext,
  auth: SessionAuth,
  orgId: string,
): Promise<GoogleIssuerRun> {
  if (sessionOf(auth).mode !== 'live')
    throw new ForbiddenError(
      'The requested mode does not match the session.',
      'WALLET_MODE_MISMATCH',
    );
  await tenantAuthorityOf(ctx, auth, orgId, 'integrations:manage');
  await requireEntitled(ctx, orgId, 'identity.managed');
  return (await startManagedIssuer(ctx, { orgId, createdBy: auth.userId })).run;
}

export async function managedIssuerStatus(
  ctx: ServiceContext,
  auth: SessionAuth,
  orgId: string,
): Promise<{ run: GoogleIssuerRun | null }> {
  await tenantAuthorityOf(ctx, sessionOf(auth), orgId, 'integrations:read');
  return { run: await latestManagedRun(ctx, orgId) };
}
