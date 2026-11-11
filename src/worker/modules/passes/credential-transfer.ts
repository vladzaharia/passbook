import { strictEmail } from '../../../shared/email.ts';
import { type Envelope, encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { dispatchSafely } from '../delivery/issuance-intent.ts';
import { ensureCredentialRefKeyset } from './credential-keyset.ts';
import { assertCredentialTransferActor } from './credential-transfer-authority.ts';
import {
  approvedForTransfer,
  buildTransfer,
  CredentialTransferReissueRequired,
  captureContent,
  conflict,
  newCredentialRefs,
  releaseSnapshot,
  retiredCredentials,
  transferContent,
  transferPayloadAad,
} from './credential-transfer-build.ts';
import { getPassForWrite } from './pass-access.ts';
import { validConnectionPassContext } from './repo.ts';
import { startTransferBatch } from './repo-credential-transfer.ts';
import { finishTransferBatch } from './repo-credential-transfer-finish.ts';
import {
  type ConnectionTransferBinding,
  type CredentialTransferAuthority,
  type CredentialTransferTarget,
  readCredentialTransfer,
  readTransferConnection,
  readTransferPass,
  retirementComplete,
  type TransferPass,
  type TransferRow,
  tombstoneExists,
  unresolvedRetainedClaim,
} from './repo-credential-transfer-read.ts';
import { matchesCredentialSource } from './repo-credential-transfer-source.ts';
import { assertWritableMode, readMode, type ScopeArg, scopeOrg } from './scope.ts';
import type { Actor } from './service.ts';

export { CredentialTransferReissueRequired } from './credential-transfer-build.ts';
export type {
  CredentialTransferAuthority,
  CredentialTransferSource,
  CredentialTransferTarget,
} from './repo-credential-transfer-read.ts';
export interface CredentialTransferResult {
  transferId: string;
  state: 'pending' | 'completed';
}

function sourceMatchesTransfer(source: TransferPass, transfer: TransferRow): boolean {
  const p = source.pass;
  return (
    p.id === transfer.pass_id &&
    p.orgId === transfer.org_id &&
    p.mode === transfer.mode &&
    source.credentialGeneration === transfer.target_generation &&
    source.lifecycleGeneration === transfer.source_lifecycle_generation &&
    p.linkGeneration === transfer.source_link_generation &&
    !p.testDataQuarantined
  );
}

/** Start is the irreversible revocation boundary, even if retirement or signing later fails. */
export async function startCredentialTransfer(
  ctx: ServiceContext,
  actor: Actor,
  passId: string,
  requested: CredentialTransferTarget,
  scope: ScopeArg,
  authority: CredentialTransferAuthority,
): Promise<CredentialTransferResult> {
  // Pin key bindings before any await so the commitment and every reference use one keyset.
  ctx = { ...ctx, env: { ...ctx.env } };
  authority = structuredClone(authority);
  actor = { ...actor };
  const connectionContent =
    authority.kind === 'connection' ? captureContent(authority.content) : null;
  const email = requested.holderEmail === null ? null : strictEmail(requested.holderEmail);
  if (requested.holderEmail !== null && !email)
    throw new ValidationError('Enter a valid email address.', [], 'EMAIL_INVALID');
  if (requested.ownerUserId !== null && (!requested.ownerUserId || !email))
    throw new ValidationError();
  const target = { holderEmail: email, ownerUserId: requested.ownerUserId };
  assertCredentialTransferActor(actor, authority, target);
  const source = await readTransferPass(ctx.env.DB, passId);
  if (
    !source ||
    (scopeOrg(scope) !== null && scopeOrg(scope) !== source.pass.orgId) ||
    (readMode(scope) !== null && readMode(scope) !== source.pass.mode)
  )
    throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  assertWritableMode(scope, source.pass.mode);
  if (authority.kind !== 'self-remove') await getPassForWrite(ctx.env.DB, passId, scope);
  if (
    authority.kind !== 'session' &&
    authority.kind !== 'api_key' &&
    !matchesCredentialSource(source, authority.expected)
  )
    throw conflict();
  if (
    source.pass.testDataQuarantined ||
    !Number.isSafeInteger(source.credentialGeneration) ||
    source.credentialGeneration < 1 ||
    source.credentialGeneration >= Number.MAX_SAFE_INTEGER
  )
    throw conflict();
  const release = await approvedForTransfer(ctx, source);
  if (
    authority.kind === 'connection' &&
    (!validConnectionPassContext(authority.connection) ||
      authority.connection.passId !== passId ||
      (authority.connection.retainedReleaseProof &&
        (authority.connection.retainedReleaseProof.id !== release.id ||
          authority.connection.retainedReleaseProof.generation !== release.generation ||
          authority.connection.retainedReleaseProof.version !== release.version)))
  )
    throw conflict();
  const content =
    connectionContent ??
    captureContent({
      personalization: source.pass.personalization,
      fieldSources: source.pass.fieldSources,
    });
  const build = await buildTransfer(ctx, source, release, content);
  const credentialKeysetCommitment = await ensureCredentialRefKeyset(ctx.env.DB, ctx.env);
  const [old, targetRefs] = await Promise.all([
    retiredCredentials(ctx, source),
    newCredentialRefs(ctx, source, build),
  ]);
  const oldRefs = new Set(old.map((entry) => entry.ref));
  if (
    targetRefs.some((ref) => oldRefs.has(ref)) ||
    (await tombstoneExists(ctx.env.DB, source.pass.orgId, source.pass.mode, targetRefs))
  )
    throw new CredentialTransferReissueRequired(credentialKeysetCommitment);
  const token = ctx.ids.token();
  if (token === source.pass.downloadToken) throw conflict();
  const transferId = ctx.ids.id();
  const proof =
    authority.kind === 'connection'
      ? authority.connection
      : authority.kind === 'verified-attach'
        ? authority.connection
        : undefined;
  let connection: { binding: ConnectionTransferBinding; envelope: Envelope } | undefined;
  if (proof) {
    const current = await readTransferConnection(ctx.env.DB, source.pass.orgId, proof.connectionId);
    if (
      !current ||
      current.generation !== proof.generation ||
      proof.orgId !== source.pass.orgId ||
      (authority.kind === 'connection' &&
        authority.connection.expectedConnectionMode !== undefined &&
        current.mode !== authority.connection.expectedConnectionMode)
    )
      throw conflict();
    const binding: ConnectionTransferBinding = {
      connectionId: proof.connectionId,
      externalRef: proof.externalRef,
      generation: proof.generation,
      mode: current.mode,
      releaseId: release.id,
      releaseGeneration: release.generation,
      releaseVersion: release.version,
    };
    const envelope = await encryptSecret(
      await loadKekRing(ctx.env),
      JSON.stringify(content),
      transferPayloadAad(transferId, source.pass.orgId, source.pass.mode),
    );
    connection = { binding, envelope };
  }
  const started = await startTransferBatch(ctx, {
    id: transferId,
    source,
    target,
    authority,
    actor,
    token,
    now: ctx.clock.now(),
    release: releaseSnapshot(release),
    releaseVersion: release.version,
    tombstones: old,
    targetRefs,
    connection,
    credentialKeysetCommitment,
  });
  if (!started) {
    if (await unresolvedRetainedClaim(ctx.env.DB, passId, source.pass.orgId))
      ctx.log.warn('pass.transfer_blocked', { passId, code: 'TRANSFER_RETAINED_CLAIM_UNRESOLVED' });
    throw conflict();
  }
  try {
    return await finishCredentialTransfer(ctx, transferId, authority);
  } catch (error) {
    // The revocation was committed. Report the durable state rather than suggesting that a new
    // start is safe; a later sweep will retry. Never claim success after an ambiguous D1 failure.
    ctx.log.error('pass.transfer_finish_deferred', {
      transferId,
      passId,
      code: 'TRANSFER_DEFERRED',
      error,
    });
    const current = await readCredentialTransfer(ctx.env.DB, transferId);
    if (!current) throw error;
    return { transferId, state: current.state };
  }
}

/** Complete only with a fresh, approved artifact and commit-time provider-retirement proof. */
export async function finishCredentialTransfer(
  ctx: ServiceContext,
  transferId: string,
  authority?: CredentialTransferAuthority,
): Promise<CredentialTransferResult> {
  // A resumed transfer must derive its commitment and references from the same key snapshot.
  ctx = { ...ctx, env: { ...ctx.env } };
  const transfer = await readCredentialTransfer(ctx.env.DB, transferId);
  if (!transfer) throw new NotFoundError('Transfer not found.', 'PASS_TRANSFER_NOT_FOUND');
  if (transfer.state === 'completed') return { transferId, state: 'completed' };
  const source = await readTransferPass(ctx.env.DB, transfer.pass_id);
  if (
    !source ||
    !sourceMatchesTransfer(source, transfer) ||
    !(await retirementComplete(ctx.env.DB, transfer))
  )
    return { transferId, state: 'pending' };
  // The finish rebuilds against the release head and the connection as they are now; an approval or a
  // connection edit while the transfer is pending moves neither the binding nor the write (F11/F15).
  const release = await approvedForTransfer(ctx, source);
  const content = await transferContent(ctx, transfer, source);
  const credentialKeysetCommitment = await ensureCredentialRefKeyset(ctx.env.DB, ctx.env);
  const build = await buildTransfer(ctx, source, release, content);
  const targetRefs = await newCredentialRefs(ctx, source, build);
  if (await tombstoneExists(ctx.env.DB, source.pass.orgId, source.pass.mode, targetRefs))
    throw new CredentialTransferReissueRequired(credentialKeysetCommitment);
  const now = ctx.clock.now();
  const objectKey = `passes/${source.pass.id}/v${source.pass.version + 1}-${ctx.ids.token(6)}.pkpass`;
  const stored = await ctx.env.BUCKET.put(objectKey, build.artifact.bytes, {
    httpMetadata: { contentType: 'application/vnd.apple.pkpass' },
    onlyIf: new Headers({ 'If-None-Match': '*' }),
  });
  if (!stored) throw conflict();
  let written: boolean;
  try {
    written = await finishTransferBatch(ctx, {
      authority,
      transfer,
      source,
      release: releaseSnapshot(release),
      releaseVersion: release.version,
      ...build.credentials,
      barcodeHash: build.artifact.barcodeHash,
      lookupHash: build.artifact.lookupHash,
      targetRefs,
      objectKey,
      objectSha256: build.artifact.sha256,
      objectSize: build.artifact.bytes.length,
      contentHash: build.artifact.contentHash,
      content,
      credentialKeysetCommitment,
      passJson: JSON.stringify(build.artifact.passJson),
      title: build.artifact.title,
      subtitle: build.artifact.subtitle,
      now,
    });
  } catch (error) {
    // A reported SQLite constraint rolled the batch back. Transport errors are ambiguous: keep
    // the object until independent GC proves it unreferenced rather than deleting a committed pass.
    if (classifyD1Error(error)) await ctx.env.BUCKET.delete(objectKey);
    ctx.log.error('pass.transfer_publish_failed', {
      transferId,
      passId: transfer.pass_id,
      code: 'TRANSFER_D1',
      error,
    });
    throw error;
  }
  if (!written) {
    await ctx.env.BUCKET.delete(objectKey);
    const current = await readCredentialTransfer(ctx.env.DB, transferId);
    if (!current) throw new NotFoundError('Transfer not found.', 'PASS_TRANSFER_NOT_FOUND');
    return { transferId, state: current.state };
  }
  ctx.waitUntil(dispatchSafely(ctx, { passId: transfer.pass_id }));
  return { transferId, state: 'completed' };
}
