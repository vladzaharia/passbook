import { ConflictError, NotFoundError, UpstreamError } from '../../platform/errors.ts';
import { fromBase64, toBase64 } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getOrgRow } from '../orgs/repo.ts';
import {
  abandonPendingCertificate,
  activatePendingCertificate,
  beginPendingCertificate,
} from './cert-history.ts';
import { buildIdentityMaterial } from './certificates.ts';
import { generateCsr } from './csr.ts';
import { intermediatePem } from './env-identity.ts';
import { passTypeOf } from './handles.ts';
import { openPendingKey, sealPendingKey } from './pending-key.ts';
import { auditOnce, beginStep, type LoadedRun, loadRun, patchRef } from './provision-run.ts';
import { getIdentityRow, type IdentityRow } from './repo.ts';
import { getCertificateRow, listCertificateRows } from './repo-certificates.ts';
import {
  getManagedState,
  identityByPassType,
  insertProvisioningIdentity,
  managedIdentityOf,
  openIdentity,
  setAscPassTypeId,
  setNextRotation,
  setOrgDefaultIdentity,
} from './repo-provision.ts';
import { patchRunRef, type RunRow } from './repo-runs.ts';

const DAY = 86_400_000;
/** Rotation starts this long before expiry (design 5.1). */
export const ROTATE_BEFORE_MS = 60 * DAY;

export async function stepLoad(
  ctx: ServiceContext,
  runId: string,
): Promise<{ kind: RunRow['kind']; done: boolean }> {
  const { run } = await loadRun(ctx, runId);
  if (run.state === 'succeeded') return { kind: run.kind, done: true };
  const loaded = await beginStep(ctx, runId, 'load');
  const db = ctx.env.DB;
  if (run.kind === 'provision') {
    const org = await getOrgRow(db, run.target_id);
    if (!org || org.status === 'deleted')
      throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
    const existing = await managedIdentityOf(db, org.id);
    if (existing?.cert_pem)
      throw new ConflictError(
        'This organization already has a managed identity.',
        'IDENTITY_ALREADY_PROVISIONED',
      );
    await auditOnce(
      ctx,
      loaded,
      'identity.provision_requested',
      {
        requestedHandle: loaded.ref.requestedHandle ?? null,
      },
      null,
    );
  } else {
    const row = await getManagedState(db, run.target_id);
    if (!row) throw new NotFoundError('Signing identity not found.', 'IDENTITY_NOT_FOUND');
    if (row.org_id !== run.org_id)
      throw new ConflictError('The identity changed owner.', 'IDENTITY_CHANGED');
  }
  return { kind: run.kind, done: false };
}

/** Records the pass type Apple has, found or created, and audits it: the handle is reserved for this org, so a found one is ours. */
export async function recordPassType(
  ctx: ServiceContext,
  runId: string,
  passType: { ascId: string },
): Promise<void> {
  const loaded = await loadRun(ctx, runId);
  await patchRef(ctx, runId, { ascPassTypeId: passType.ascId });
  if (loaded.run.kind === 'rotate') {
    await setAscPassTypeId(ctx.env.DB, loaded.run.target_id, passType.ascId);
    return;
  }
  await auditOnce(
    ctx,
    loaded,
    'identity.pass_type_created',
    { passTypeIdentifier: passTypeOf(loaded.ref.handle ?? '') },
    null,
  );
}

export async function identifierOf(ctx: ServiceContext, identityId: string): Promise<string> {
  const row = await getIdentityRow(ctx.env.DB, identityId);
  if (!row) throw new NotFoundError('Signing identity not found.', 'IDENTITY_NOT_FOUND');
  return row.pass_type_identifier;
}

export async function orgNameOf(ctx: ServiceContext, orgId: string): Promise<string> {
  const org = await getOrgRow(ctx.env.DB, orgId);
  if (!org) throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  return org.name;
}

/** The identity row of a rotate run, or the managed row a provision run builds. */
async function identityOf({ run, ref }: LoadedRun, ctx: ServiceContext): Promise<IdentityRow> {
  const id = run.kind === 'rotate' ? run.target_id : ref.identityId;
  const row = id ? await getIdentityRow(ctx.env.DB, id) : null;
  if (!row) throw new NotFoundError('Signing identity not found.', 'IDENTITY_NOT_FOUND');
  return row;
}

/** Generates the key and CSR once per run: a retry reuses the pending row recorded on the run. */
export async function stepKey(ctx: ServiceContext, runId: string): Promise<void> {
  const loaded = await beginStep(ctx, runId, 'key');
  const { run, ref } = loaded;
  const db = ctx.env.DB;
  const known = ref.certId ? await getCertificateRow(db, ref.certId) : null;
  if (known && (known.state === 'pending' || known.state === 'active') && ref.csrDerB64) return;

  if (run.kind === 'provision') {
    const passType = passTypeOf(ref.handle ?? '');
    const existing = await identityByPassType(db, passType);
    if (existing && existing.org_id !== run.target_id)
      throw new ConflictError('This pass type belongs to another identity.', 'IDENTITY_PTI_TAKEN');
    if (!existing) {
      if (!ref.ascPassTypeId)
        throw new UpstreamError('Apple pass type is not recorded.', 'ASC_PASS_TYPE_MISSING');
      const csr = await generateCsr(passType);
      const identityId = ctx.ids.id();
      const certId = ctx.ids.id();
      await insertProvisioningIdentity(db, {
        id: identityId,
        orgId: run.target_id,
        label: `Managed ${ref.handle}`,
        passTypeIdentifier: passType,
        teamIdentifier: ctx.env.PLATFORM_TEAM_ID,
        handle: ref.handle ?? '',
        ascPassTypeId: ref.ascPassTypeId,
        nfcEnabled: false,
        pending: {
          id: certId,
          identityId,
          origin: 'asc',
          credential: await sealPendingKey(ctx.env, {
            id: ctx.ids.id(),
            orgId: run.target_id,
            privateKeyPem: csr.privateKeyPem,
            pubkeySha256: csr.pubkeySha256,
          }),
          now: ctx.clock.now(),
        },
        now: ctx.clock.now(),
      });
      await patchRunRef(
        db,
        runId,
        { identityId, certId, csrDerB64: toBase64(csr.csrDer) },
        ctx.clock.now(),
        csr.pubkeySha256,
      );
      ctx.log.info('identity.provision_row_created', { runId, identityId });
      return;
    }
    await patchRef(ctx, runId, { identityId: existing.id });
  }

  // Rotation, or a provision whose identity row exists but whose run lost its CSR: start a fresh key.
  const row = await identityOf(await loadRun(ctx, runId), ctx);
  // A half-built identity's own pending key stays until activation replaces it.
  for (const stale of await listCertificateRows(db, row.id))
    if (
      stale.state === 'pending' &&
      stale.origin === 'asc' &&
      stale.credential_id !== row.credential_id
    )
      await abandonPendingCertificate(ctx, stale.id);
  const pending = await beginPendingCertificate(ctx, row, 'asc');
  await patchRunRef(
    db,
    runId,
    { certId: pending.certId, csrDerB64: toBase64(pending.csrDer) },
    ctx.clock.now(),
    pending.pubkeySha256,
  );
}

export interface IssueInput {
  ascPassTypeId: string;
  csrDer: Uint8Array;
  pubkeySha256: string;
  nfc: boolean;
}

/** What the Apple calls of the `issue` step need, read from the run. */
export async function issueInput(ctx: ServiceContext, runId: string): Promise<IssueInput | null> {
  const { run, ref } = await beginStep(ctx, runId, 'issue');
  const known = ref.certId ? await getCertificateRow(ctx.env.DB, ref.certId) : null;
  if (known?.state === 'active') return null;
  if (!ref.ascPassTypeId || !ref.csrDerB64 || !run.csr_pubkey_sha256)
    throw new UpstreamError('The run has no CSR to issue.', 'IDENTITY_RUN_INCOMPLETE');
  const row = await identityOf({ run, ref }, ctx);
  return {
    ascPassTypeId: ref.ascPassTypeId,
    csrDer: fromBase64(ref.csrDerB64),
    pubkeySha256: run.csr_pubkey_sha256,
    nfc: row.nfc_enabled === 1,
  };
}

export async function recordIssued(
  ctx: ServiceContext,
  runId: string,
  cert: { ascId: string; der: Uint8Array | null },
): Promise<void> {
  if (!cert.der) throw new UpstreamError('Apple returned no certificate.', 'ASC_CERT_MISSING');
  await patchRef(ctx, runId, { ascCertificateId: cert.ascId, certDerB64: toBase64(cert.der) });
  await auditOnce(ctx, await loadRun(ctx, runId), 'identity.certificate_issued', {
    ascCertificateId: cert.ascId,
  });
}

/** Chain, pass type, team, key match and dates, then a probe signature. Writes nothing. */
export async function stepValidate(ctx: ServiceContext, runId: string): Promise<void> {
  const loaded = await beginStep(ctx, runId, 'validate');
  const { ref } = loaded;
  const pending = ref.certId ? await getCertificateRow(ctx.env.DB, ref.certId) : null;
  if (pending?.state === 'active') return;
  if (!pending?.credential_id || !ref.certDerB64)
    throw new UpstreamError('The run has no certificate to validate.', 'IDENTITY_RUN_INCOMPLETE');
  const row = await identityOf(loaded, ctx);
  await buildIdentityMaterial({
    certificateDer: fromBase64(ref.certDerB64),
    privateKeyPem: await openPendingKey(ctx.env, pending.credential_id, row.org_id),
    passTypeIdentifier: row.pass_type_identifier,
    teamIdentifier: row.team_identifier,
    intermediatePem: intermediatePem(ctx.env),
    now: ctx.clock.now(),
  });
}

/** Compare-and-swap activation, then the next rotation time. Safe to repeat. */
export async function stepActivate(ctx: ServiceContext, runId: string): Promise<void> {
  const loaded = await beginStep(ctx, runId, 'activate');
  const { run, ref } = loaded;
  if (!ref.certId || !ref.certDerB64)
    throw new UpstreamError('The run has no certificate to activate.', 'IDENTITY_RUN_INCOMPLETE');
  const row = await identityOf(loaded, ctx);
  const details = await activatePendingCertificate(ctx, row, ref.certId, {
    certificateDer: fromBase64(ref.certDerB64),
    ascCertificateId: ref.ascCertificateId ?? null,
  });
  await setNextRotation(ctx.env.DB, row.id, details.notAfter - ROTATE_BEFORE_MS);
  for (const stale of await listCertificateRows(ctx.env.DB, row.id))
    if (stale.state === 'pending' && stale.origin === 'asc' && stale.id !== ref.certId)
      await abandonPendingCertificate(ctx, stale.id);
  await auditOnce(
    ctx,
    await loadRun(ctx, runId),
    run.kind === 'rotate' ? 'identity.rotated' : 'identity.provisioned',
    {
      passTypeIdentifier: row.pass_type_identifier,
      certSha256: details.sha256,
      notAfter: details.notAfter,
    },
  );
}

/** Provision only: the identity takes new passes, and the org signs new passes with it. */
export async function stepDefault(ctx: ServiceContext, runId: string): Promise<void> {
  const { run, ref } = await beginStep(ctx, runId, 'default');
  if (!ref.identityId)
    throw new UpstreamError('The run has no identity.', 'IDENTITY_RUN_INCOMPLETE');
  await openIdentity(ctx.env.DB, ref.identityId);
  await setOrgDefaultIdentity(ctx, run.target_id, ref.identityId);
}
