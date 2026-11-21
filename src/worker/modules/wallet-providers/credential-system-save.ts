import type { GoogleWalletCredentials } from '../../../shared/contracts/wallet-providers.ts';
import { jobGrant } from '../../platform/authority.ts';
import { epochIs } from '../../platform/authority-checks.ts';
import { credentialAad, encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { corrupt } from './account-credential-material.ts';
import { credentialIdentityHash, openSourceVersion } from './account-credential-source.ts';
import {
  CREDENTIAL_TABLES,
  type CredentialRow,
  findCredential,
  stageCredentialSave,
} from './repo-credentials.ts';
import { versionRow } from './repo-google-managed.ts';
import { mapWalletWriteError } from './wallet-write-errors.ts';

/** The Google secret in a credential's current version, or in the named one. */
export async function readGoogleSecret(
  ctx: ServiceContext,
  credentialId: string,
  versionId: string | null = null,
): Promise<{ credentials: GoogleWalletCredentials; versionId: string }> {
  const row = await versionRow(ctx.env.DB, credentialId, versionId);
  if (row?.provider !== 'google') throw corrupt();
  const opened = await openSourceVersion(
    ctx,
    { id: credentialId, orgId: row.credential_org_id ?? '', mode: row.mode, provider: 'google' },
    row,
  );
  if (opened.provider !== 'google') throw corrupt();
  return { credentials: opened.credentials, versionId: opened.versionId };
}

export interface SystemSave {
  /** The org's credential, or the platform's (`orgId` null). */
  orgId: string | null;
  mode: 'live' | 'test';
  /** Null creates the credential; a row rotates it as a new version. */
  current: CredentialRow | null;
  secret: GoogleWalletCredentials;
  origin?: { provenance: 'managed' | 'own'; signerRef: string | null };
  nextRotationAt?: number | null;
}

/**
 * Creates or rotates a Google credential under a job grant: the version, its event and the pointer in one
 * batch, as a member's save does. A stale revision loses the epoch check and nothing is written.
 */
export async function saveSystemCredential(
  ctx: ServiceContext,
  s: SystemSave,
  purposeName: string,
): Promise<CredentialRow> {
  const credentialId = s.current?.id ?? ctx.ids.id();
  const versionId = ctx.ids.id();
  const expectedRevision = s.current?.revision ?? 0;
  const identityHash = await credentialIdentityHash({ provider: 'google', credentials: s.secret });
  if (s.current && s.current.identity_hash !== identityHash) throw corrupt();
  const platform = s.orgId === null;
  const kind = `wallet-credential:${credentialId}:${platform ? 'platform' : 'org'}:${s.mode}:google`;
  const envelope = await encryptSecret(
    await loadKekRing(ctx.env),
    JSON.stringify({ version: 1, provider: 'google', credentials: s.secret }),
    credentialAad(versionId, s.orgId, kind),
  );
  const g = jobGrant(ctx, {
    purpose: platform ? `platform.job.wallet.${purposeName}` : `org_mode.job.wallet.${purposeName}`,
    job: `wallet-${purposeName.replaceAll('_', '-')}`,
    ...(platform ? {} : { orgId: s.orgId as string, mode: s.mode }),
    tables: CREDENTIAL_TABLES,
    codes: { config: 'WALLET_ACCOUNT_CONFLICT' },
    checks: s.current
      ? [epochIs('wallet_credentials', credentialId, 'revision', expectedRevision)]
      : [],
  });
  stageCredentialSave(
    g,
    ctx,
    { actor: { type: 'system', id: null }, platform },
    {
      credentialId,
      expectedRevision,
      mode: s.mode,
      provider: 'google',
      identityHash,
      identityHint: s.secret.issuerId.slice(-4),
      versionId,
      eventId: ctx.ids.id(),
      cardMap: {},
      envelope,
      ...(s.origin ? { origin: s.origin } : {}),
      ...(s.nextRotationAt === undefined ? {} : { nextRotationAt: s.nextRotationAt }),
    },
  );
  try {
    await g.commit();
  } catch (error) {
    throw mapWalletWriteError(error);
  }
  const saved = await findCredential(ctx.env.DB, credentialId, s.orgId);
  if (!saved) throw corrupt();
  return saved;
}
