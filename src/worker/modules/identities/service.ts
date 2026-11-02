import type { z } from 'zod';
import type {
  IdentityDto,
  RotateIdentitySchema,
  UpdateIdentitySchema,
  UploadIdentitySchema,
} from '../../../shared/contracts/identities.ts';
import type { Actor } from '../../platform/context.ts';
import { credentialAad, encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditActor, recordAudit } from '../audit/service.ts';
import { orgIsReadable } from '../orgs/repo.ts';
import { certDetails, invalid, validateIdentityMaterial } from './cert.ts';
import { checkIdentityById } from './check.ts';
import { apnsBindingPresent, clearIdentityKeyCache } from './db-resolver.ts';
import { intermediatePem, PLATFORM_IDENTITY_ID } from './env-identity.ts';
import { daysRemaining } from './expiry.ts';
import { readPkcs12 } from './pkcs12.ts';
import {
  deleteIdentityRows,
  findByPassType,
  getIdentityRow,
  type IdentityRow,
  identityFacts,
  identityInUse,
  insertIdentity,
  listIdentityRows,
  rotateIdentityRows,
  updateIdentityRow,
} from './repo.ts';

type Upload = z.infer<typeof UploadIdentitySchema>;
type Patch = z.infer<typeof UpdateIdentitySchema>;
type Rotation = z.infer<typeof RotateIdentitySchema>;

/** Only APNS_* bindings: the name is looked up on env, so it must never reach DB, KEK_* or ASSETS. */
const BINDING_NAME = /^APNS_[A-Z0-9_]{1,59}$/;

/** Apple's reason code from a probe's audit detail; null when it passed or none was given. */
function probeReason(detail: string | null): string | null {
  if (!detail) return null;
  try {
    const parsed = JSON.parse(detail) as { reason?: unknown };
    return typeof parsed.reason === 'string' ? parsed.reason : null;
  } catch {
    // Audit detail is written as JSON by probeRow; anything else carries no reason.
    return null;
  }
}

export async function toDto(ctx: ServiceContext, row: IdentityRow): Promise<IdentityDto> {
  const facts = await identityFacts(ctx.env.DB, row.id);
  let subject: string | null = null;
  let serial: string | null = null;
  if (row.cert_pem) {
    try {
      const details = await certDetails(row.cert_pem);
      subject = details.subject;
      serial = details.serial;
    } catch (error) {
      ctx.log.warn('identity.cert_unreadable', { identityId: row.id, error });
    }
  }
  return {
    id: row.id,
    orgId: row.org_id,
    label: row.label,
    passTypeIdentifier: row.pass_type_identifier,
    teamIdentifier: row.team_identifier,
    source: row.source,
    certSha256: row.cert_sha256,
    certSubject: subject,
    certSerial: serial,
    notBefore: row.not_before,
    notAfter: row.not_after,
    daysRemaining: daysRemaining(row.not_after, ctx.clock.now()),
    apnsBinding: row.apns_binding,
    apnsAvailable: apnsBindingPresent(ctx.env, row.apns_binding),
    apnsHealth: row.apns_health,
    apnsCheckedAt: facts.checked_at,
    apnsReason: probeReason(facts.detail),
    passCount: facts.pass_count,
    nfcEnabled: row.nfc_enabled === 1,
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
  };
}

async function requireRow(ctx: ServiceContext, id: string): Promise<IdentityRow> {
  const row = await getIdentityRow(ctx.env.DB, id);
  if (!row) throw new NotFoundError('Signing identity not found.', 'IDENTITY_NOT_FOUND');
  return row;
}

export async function listIdentities(ctx: ServiceContext): Promise<{ items: IdentityDto[] }> {
  const rows = await listIdentityRows(ctx.env.DB);
  return { items: await Promise.all(rows.map((row) => toDto(ctx, row))) };
}

export async function getIdentity(ctx: ServiceContext, id: string): Promise<IdentityDto> {
  return toDto(ctx, await requireRow(ctx, id));
}

async function materialOf(
  input: Upload | Rotation,
): Promise<{ certificatePem: string; privateKeyPem: string }> {
  if (input.pkcs12Base64) {
    const p12 = await readPkcs12(input.pkcs12Base64, input.pkcs12Password ?? '');
    // The leaf is the certificate that carries the pass type ID.
    const leaf = await Promise.all(
      p12.certificates.map(async (pem) => ({ pem, d: await certDetails(pem) })),
    );
    const picked = leaf.find((c) => c.d.passTypeIdentifier) ?? leaf[0];
    return { certificatePem: picked?.pem ?? '', privateKeyPem: p12.privateKeyPem };
  }
  if (!input.certificatePem || !input.privateKeyPem)
    throw invalid('Send certificatePem and privateKeyPem, or pkcs12Base64.', 'IDENTITY_INPUT');
  return { certificatePem: input.certificatePem, privateKeyPem: input.privateKeyPem };
}

export async function uploadIdentity(
  ctx: ServiceContext,
  actor: Actor,
  input: Upload,
): Promise<IdentityDto> {
  const orgId = input.orgId ?? null;
  if (orgId && !(await orgIsReadable(ctx.env.DB, orgId)))
    throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  if (input.pkcs12Base64 && (input.certificatePem || input.privateKeyPem))
    throw invalid('Send either PEM files or a PKCS#12 file, not both.', 'IDENTITY_INPUT');

  const material = await materialOf(input);
  const checked = await validateIdentityMaterial({
    ...material,
    intermediatePem: intermediatePem(ctx.env),
    now: ctx.clock.now(),
  });
  const { details } = checked;
  const passTypeIdentifier = details.passTypeIdentifier ?? '';
  if (await findByPassType(ctx.env.DB, passTypeIdentifier))
    throw new ConflictError(
      'An identity with this pass type ID already exists.',
      'IDENTITY_EXISTS',
    );

  const id = ctx.ids.id();
  const credentialId = ctx.ids.id();
  const envelope = await encryptSecret(
    await loadKekRing(ctx.env),
    checked.privateKeyPem,
    credentialAad(credentialId, orgId, 'pass_signer'),
  );
  await insertIdentity(ctx.env.DB, {
    credential: {
      id: credentialId,
      orgId,
      kekVersion: envelope.kekVersion,
      iv: envelope.iv,
      wrappedDek: envelope.wrappedDek,
      ciphertext: envelope.ciphertext,
      fingerprint: details.sha256,
    },
    identity: {
      id,
      orgId,
      label: input.label,
      passTypeIdentifier,
      teamIdentifier: details.teamIdentifier ?? '',
      certPem: checked.certificatePem,
      certSha256: details.sha256,
      notBefore: details.notBefore,
      notAfter: details.notAfter,
      nfcEnabled: input.nfcEnabled ?? false,
    },
    now: ctx.clock.now(),
  });
  await recordAudit(ctx, {
    ...auditActor(actor),
    orgId,
    action: 'identity.upload',
    targetType: 'identity',
    targetId: id,
    detail: {
      label: input.label,
      passTypeIdentifier,
      teamIdentifier: details.teamIdentifier,
      certSha256: details.sha256,
      notAfter: details.notAfter,
    },
  });
  await checkIdentityById(ctx, id);
  return getIdentity(ctx, id);
}

export async function updateIdentity(
  ctx: ServiceContext,
  actor: Actor,
  id: string,
  patch: Patch,
): Promise<IdentityDto> {
  const row = await requireRow(ctx, id);
  if (patch.apnsBinding !== undefined) {
    if (row.source === 'env')
      throw new ValidationError(
        'The platform APNs binding comes from the deployment.',
        [{ path: 'apnsBinding', message: 'Managed by the deployment.' }],
        'APNS_BINDING_MANAGED',
      );
    if (patch.apnsBinding !== null && !BINDING_NAME.test(patch.apnsBinding))
      throw new ValidationError('Invalid binding name.', [
        { path: 'apnsBinding', message: 'Use a binding name such as APNS_ACME.' },
      ]);
  }
  const next = {
    label: patch.label ?? row.label,
    nfcEnabled: patch.nfcEnabled ?? row.nfc_enabled === 1,
    apnsBinding: patch.apnsBinding === undefined ? row.apns_binding : patch.apnsBinding,
    isDefault: patch.isDefault ?? row.is_default === 1,
  };
  await updateIdentityRow(ctx.env.DB, id, next);
  await recordAudit(ctx, {
    ...auditActor(actor),
    orgId: row.org_id,
    action: 'identity.update',
    targetType: 'identity',
    targetId: id,
    detail: { patch },
  });
  return getIdentity(ctx, id);
}

export async function deleteIdentity(ctx: ServiceContext, actor: Actor, id: string): Promise<void> {
  const row = await requireRow(ctx, id);
  if (row.source === 'env' || id === PLATFORM_IDENTITY_ID)
    throw new ConflictError('The platform identity cannot be deleted.', 'IDENTITY_PROTECTED');
  if (await identityInUse(ctx.env.DB, id))
    throw new ConflictError(
      'Passes still use this identity. Delete them first, or rotate its certificate to renew it.',
      'IDENTITY_IN_USE',
    );
  await deleteIdentityRows(ctx.env.DB, id, row.credential_id);
  await recordAudit(ctx, {
    ...auditActor(actor),
    orgId: row.org_id,
    action: 'identity.delete',
    targetType: 'identity',
    targetId: id,
    detail: { label: row.label, passTypeIdentifier: row.pass_type_identifier },
  });
}

/** Yearly renewal: new certificate and key for the same pass type ID; existing passes keep working. */
export async function rotateIdentity(
  ctx: ServiceContext,
  actor: Actor,
  id: string,
  input: Rotation,
): Promise<IdentityDto> {
  const row = await requireRow(ctx, id);
  if (row.source === 'env' || id === PLATFORM_IDENTITY_ID)
    throw new ConflictError(
      'The platform certificate rotates through deployment secrets.',
      'IDENTITY_PROTECTED',
    );
  if (input.pkcs12Base64 && (input.certificatePem || input.privateKeyPem))
    throw invalid('Send either PEM files or a PKCS#12 file, not both.', 'IDENTITY_INPUT');
  const checked = await validateIdentityMaterial({
    ...(await materialOf(input)),
    intermediatePem: intermediatePem(ctx.env),
    now: ctx.clock.now(),
  });
  const { details } = checked;
  if (
    details.passTypeIdentifier !== row.pass_type_identifier ||
    (details.teamIdentifier ?? '') !== row.team_identifier
  )
    throw invalid(
      `The certificate is for ${details.passTypeIdentifier ?? 'another pass type'}, not ${row.pass_type_identifier}.`,
      'IDENTITY_MISMATCH',
    );
  const credentialId = ctx.ids.id();
  const envelope = await encryptSecret(
    await loadKekRing(ctx.env),
    checked.privateKeyPem,
    credentialAad(credentialId, row.org_id, 'pass_signer'),
  );
  await rotateIdentityRows(ctx.env.DB, {
    identityId: id,
    oldCredentialId: row.credential_id,
    credential: {
      id: credentialId,
      orgId: row.org_id,
      kekVersion: envelope.kekVersion,
      iv: envelope.iv,
      wrappedDek: envelope.wrappedDek,
      ciphertext: envelope.ciphertext,
      fingerprint: details.sha256,
    },
    certPem: checked.certificatePem,
    certSha256: details.sha256,
    notBefore: details.notBefore,
    notAfter: details.notAfter,
    now: ctx.clock.now(),
  });
  clearIdentityKeyCache();
  await recordAudit(ctx, {
    ...auditActor(actor),
    orgId: row.org_id,
    action: 'identity.rotate',
    targetType: 'identity',
    targetId: id,
    detail: {
      passTypeIdentifier: row.pass_type_identifier,
      from: row.cert_sha256,
      to: details.sha256,
      notAfter: details.notAfter,
    },
  });
  return getIdentity(ctx, id);
}
