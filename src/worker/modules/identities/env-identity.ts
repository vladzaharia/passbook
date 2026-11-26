import wwdrG4 from '../../../generated/wwdr-g4.ts';
import type { PassIdentity, SigningMaterial } from '../../../passkit/types.ts';
import { type AppEnv, envString } from '../../platform/env.ts';
import { NotFoundError } from '../../platform/errors.ts';
import type { IdentityRow } from './repo.ts';

export const PLATFORM_IDENTITY_ID = 'platform';

export interface ResolvedIdentity extends PassIdentity {
  id: string;
  orgId: string | null;
  label: string;
  /** Env var name of the mTLS binding used for APNs, e.g. APNS. Null = push unavailable. */
  apnsBinding: string | null;
  material: SigningMaterial;
}

export interface IdentityResolver {
  /**
   * Identity for a new pass: explicit id, else the org default, else the platform identity.
   * Refuses one that has stopped issuing (`IDENTITY_RETIRED`) or whose certificate has expired
   * (`IDENTITY_EXPIRED`); `byId` still serves passes already issued on it.
   */
  forOrg(
    orgId: string,
    identityId: string | null | undefined,
    now: number,
  ): Promise<ResolvedIdentity>;
  byId(identityId: string): Promise<ResolvedIdentity>;
  /** `byId` for a row the caller already read in a batch. */
  byRow?(row: IdentityRow): Promise<ResolvedIdentity>;
  platform(): Promise<ResolvedIdentity>;
  /**
   * `forOrg` and `byId` from the identity's metadata alone (status, purpose, certificate dates): the same
   * refusals, but the signing key is never read. For a dry run that only counts.
   */
  peekForOrg?(
    orgId: string,
    identityId: string | null | undefined,
    now: number,
  ): Promise<{ id: string }>;
  peekById?(identityId: string): Promise<{ id: string }>;
}

/** Intermediate for chain checks: SIGNER_PLATFORM_INTERMEDIATE override, else the bundled WWDR G4. */
export function intermediatePem(env: AppEnv): string {
  return envString(env, 'SIGNER_PLATFORM_INTERMEDIATE') ?? wwdrG4;
}

/** Whether the deployment still carries the legacy platform certificate and key. */
export function envIdentityPresent(env: AppEnv, prefix = 'PLATFORM'): boolean {
  return (
    !!envString(env, `SIGNER_${prefix}_CERTIFICATE`) &&
    !!envString(env, `SIGNER_${prefix}_PRIVATE_KEY`)
  );
}

export function readEnvIdentity(env: AppEnv, prefix = 'PLATFORM'): ResolvedIdentity {
  const certificate = envString(env, `SIGNER_${prefix}_CERTIFICATE`);
  const privateKey = envString(env, `SIGNER_${prefix}_PRIVATE_KEY`);
  const intermediate = envString(env, `SIGNER_${prefix}_INTERMEDIATE`) ?? wwdrG4;
  if (!certificate || !privateKey)
    throw new NotFoundError(
      `Signing identity ${prefix} is not configured.`,
      'IDENTITY_NOT_CONFIGURED',
    );
  return {
    id: PLATFORM_IDENTITY_ID,
    orgId: null,
    label: 'Platform',
    passTypeIdentifier: env.PLATFORM_PASS_TYPE_ID,
    teamIdentifier: env.PLATFORM_TEAM_ID,
    nfcEnabled: false,
    apnsBinding: env.APNS ? 'APNS' : null,
    material: { certificate, privateKey, intermediate },
  };
}
