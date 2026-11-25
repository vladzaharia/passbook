import { stampInput } from '../../../passkit/behaviors/term/index.ts';
import { strictEmail } from '../../../shared/email.ts';
import { writeEvent } from '../../platform/analytics.ts';
import { issueToken } from '../../platform/capability-token.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { baseUrl } from '../../platform/env.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { isPreviewOnlyOrg } from '../developer/fence.ts';
import { ensurePlatformIdentity } from '../identities/repo.ts';
import { PLATFORM_IDENTITY_ID } from '../identities/resolver.ts';
import type { TemplateRelease } from '../templates/releases.ts';
import { assertAccessInput } from './access-input.ts';
import { buildArtifact, resolveTemplate } from './builder.ts';
import { objectFileOf } from './builder-finish.ts';
import { assertTenantCreateAuthority } from './create-authority.ts';
import { scheduleRequiredIssuanceDelivery } from './create-delivery.ts';
import { createRefusal } from './create-grant.ts';
import { assertCreateAuthority, releaseChanged } from './create-release.ts';
import type { CreateParams } from './create-types.ts';
import { requireCredentialRefKeyset } from './credential-keyset.ts';
import { credentialReferences } from './credential-references.ts';
import { depsOf } from './deps.ts';
import { assertPassDetailReadable } from './detail.ts';
import { assertExternalIdFree, uniqueExternalIds } from './external-id.ts';
import { insertPass, type Pass } from './repo.ts';
import { tombstoneExists } from './repo-credential-transfer-read.ts';
import { livePassesBy } from './repo-import-lookup.ts';
import { connectionForPass, connectionInOrg } from './repo-read-connection.ts';
import { getOrg } from './repo-read-issuance.ts';
import { getPass } from './repo-read-pass.ts';
import { lookupValueOf, newScanCode, primaryBarcodeMessage } from './scan-code.ts';

export async function createPassRowWithRelease(
  ctx: ServiceContext,
  p: CreateParams,
  release: TemplateRelease,
  keysetCommitment: string,
  credentialEnv: object,
): Promise<Pass> {
  const db = ctx.env.DB;
  if (p.source === 'connection' && (!p.connectionId || p.connectionGeneration === undefined))
    throw new ConflictError('The connection run is missing its original context.', 'PASS_CONFLICT');
  const org = await getOrg(db, p.orgId);
  if (org?.status !== 'active') throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  const holderEmail = p.holderEmail ? strictEmail(p.holderEmail) : null;
  if (p.holderEmail && !holderEmail)
    throw new ValidationError('Enter a valid email address.', [], 'EMAIL_INVALID');
  if (p.connectionId && p.mode !== 'live')
    throw new ConflictError('Test passes cannot use a Live connection.', 'MODE_MISMATCH');
  if (p.connectionId && !(await connectionInOrg(db, p.connectionId, p.orgId)))
    throw new ValidationError(
      'The connection does not belong to this organization.',
      [],
      'CONNECTION_ORG',
    );
  if (p.source === 'connection' && p.mode !== 'live')
    throw new ConflictError('Connection syncs require Live mode.', 'MODE_MISMATCH');
  let connectionGeneration: number | null = null;
  if (p.connectionId) {
    const connection = await connectionForPass(
      db,
      p.connectionId,
      p.orgId,
      p.mode,
      p.expectedConnectionMode,
    );
    if (
      !connection ||
      (p.source === 'connection' && connection.generation !== p.connectionGeneration)
    )
      throw new ConflictError('The connection changed. Reload and retry.', 'PASS_CONFLICT');
    connectionGeneration = connection.generation;
    // Manual issuance may bind a connection without an upstream run; pin its first
    // authoritative strategy together with the generation before building the artifact.
    p.expectedConnectionMode ??= connection.mode;
  }

  const template = await resolveTemplate(ctx, p.orgId, p.templateId, release.version);
  if (template.id !== release.templateId || template.version !== release.version)
    throw releaseChanged();
  const uniqueExternalId = uniqueExternalIds(template.manifest);
  const scope = { orgId: p.orgId, mode: p.mode, templateId: template.id };
  if (uniqueExternalId && p.externalId) await assertExternalIdFree(db, scope, p.externalId);
  await assertCreateAuthority(ctx, p, connectionGeneration, release);
  // A term that starts at issue is stamped once, here, so no rebuild moves it.
  const issueInput = stampInput(template.manifest, 'issue');
  const issued = issueInput ? p.input[issueInput] : undefined;
  const input =
    issueInput && (issued === undefined || issued === null || issued === '')
      ? { ...p.input, [issueInput]: new Date(ctx.clock.now()).toISOString() }
      : p.input;
  await assertAccessInput(ctx, p.orgId, template, input);
  // A developer org's pass row names the platform identity (the foreign key needs one) but never loads it:
  // nothing is signed for it, so no certificate or key is read.
  const identity = (await isPreviewOnlyOrg(db, p.orgId))
    ? { id: PLATFORM_IDENTITY_ID, orgId: null }
    : await depsOf(ctx.env).identities.forOrg(p.orgId, p.identityId, ctx.clock.now());
  if (identity.id === PLATFORM_IDENTITY_ID)
    await ensurePlatformIdentity(ctx.env, ctx.clock.now(), ctx.log);

  const id = p.reservedPassId ?? p.passId ?? ctx.ids.id();
  const mode = p.mode;
  const scanCode = newScanCode(ctx);
  // A personalizable pass is addressed by serial in Apple's personalize flow, so the caller never picks it.
  // Serials are unique per identity: on an identity shared by orgs they are server-generated, so
  // one org cannot probe or squat another's.
  const personalizable = template.assets.some((a) => a.name === 'personalization.json');
  const ownIdentity = identity.orgId !== null;
  const serial = personalizable || !ownIdentity ? ctx.ids.id() : (p.serial ?? ctx.ids.id());
  const authToken = await issueToken(ctx.env, 'apple-auth', id, p.orgId, ctx.ids.token());
  const downloadToken = await issueToken(ctx.env, 'pass', id, p.orgId, ctx.ids.token());
  const webServiceUrl = `${baseUrl(ctx.env)}/wallet`;
  const artifact = await buildArtifact(ctx, {
    orgId: p.orgId,
    orgName: org.name,
    personal: org.personal,
    branding: org.branding,
    passId: id,
    scanCode,
    serial,
    authToken: { fresh: authToken.token },
    webServiceUrl,
    identityId: identity.id,
    templateId: template.id,
    templateVersion: template.version,
    personalization: input,
    status: 'active',
  });
  // A public card's barcode is its scan code: a holder-typed value must never reach it.
  if (p.execution.kind === 'join' && primaryBarcodeMessage(artifact.passJson) !== scanCode)
    throw new ConflictError('This card is not ready for public sign-up.', 'JOIN_NOT_READY');
  const lookupInput = artifact.template.manifest.scan?.lookup?.input;
  const refs = await credentialReferences(credentialEnv, p.orgId, mode, {
    scanCode,
    serial,
    barcodeHash: artifact.barcodeHash,
    barcodeMessage: primaryBarcodeMessage(artifact.passJson),
    lookupHash: artifact.lookupHash,
    lookupValue: lookupInput ? lookupValueOf(input, lookupInput) : null,
  });
  const credentialRefs = [...new Set(refs.map((entry) => entry.ref))];
  // Building may await external assets or signing. Recheck authoritative state before storing.
  await assertCreateAuthority(ctx, p, connectionGeneration, release);
  const file = objectFileOf(artifact);
  const objectKey = `passes/${id}/v1-${ctx.ids.token(6)}${file.ext}`;
  await ctx.env.BUCKET.put(objectKey, artifact.bytes, {
    httpMetadata: { contentType: file.contentType },
  });
  let issuedOwnerUserId: string | null = null;
  let issuedRevision = 0;
  let insertInFlight = false;
  try {
    await assertTenantCreateAuthority(ctx, p);
    if (p.reservedPassId !== undefined && p.retainedClaim === undefined)
      throw new ConflictError(
        'The retained connection item changed. Retry the sync.',
        'PASS_CONFLICT',
      );
    insertInFlight = true;
    const inserted = await insertPass(ctx, {
      id,
      orgId: p.orgId,
      identityId: identity.id,
      serial,
      templateId: template.id,
      templateVersion: template.version,
      release: {
        id: release.id,
        generation: release.generation,
        orgId: release.orgId,
        candidateHash: release.candidateHash,
        provider: 'apple',
      },
      authToken: authToken.mac,
      authSeal: authToken.seal,
      downloadToken: downloadToken.mac,
      tokenSeal: downloadToken.seal,
      webServiceUrl,
      personalization: input,
      // A bound pass takes its fields from the connection until an admin edits them.
      fieldSources: Object.fromEntries(
        Object.keys(input).map((k) => [
          k,
          p.connectionId ? 'connection' : (p.fieldSource ?? p.source),
        ]),
      ),
      displayTitle: artifact.title,
      displaySubtitle: artifact.subtitle,
      externalId: p.externalId ?? null,
      uniqueExternalId,
      holderEmail,
      connectionId: p.connectionId ?? null,
      connectionGeneration,
      expectedConnectionMode: p.expectedConnectionMode,
      externalRef: p.externalRef ?? null,
      objectKey,
      objectSha256: artifact.sha256,
      objectSize: artifact.bytes.length,
      contentHash: artifact.contentHash,
      createdBy: p.actor.type === 'user' ? p.actor.id : null,
      passJson: JSON.stringify(artifact.passJson),
      actorType: p.actor.type,
      source: p.source,
      actorId: p.actor.id,
      requestId: ctx.requestId,
      mode,
      scanCode,
      barcodeHash: artifact.barcodeHash,
      lookupHash: artifact.lookupHash,
      credentialKeysetCommitment: keysetCommitment,
      credentialRefs,
      ...(p.reservedPassId !== undefined
        ? { reservedPassId: p.reservedPassId, retainedClaim: p.retainedClaim }
        : {}),
      sendEmail: Boolean(p.sendEmail && holderEmail),
      execution: p.execution,
      ...(p.joinKeys ? { joinKeys: p.joinKeys } : {}),
      now: ctx.clock.now(),
    });
    if (!inserted) {
      insertInFlight = false;
      if (uniqueExternalId && p.externalId) await assertExternalIdFree(db, scope, p.externalId);
      await assertCreateAuthority(ctx, p, connectionGeneration, release);
      await requireCredentialRefKeyset(db, credentialEnv);
      if (await tombstoneExists(db, p.orgId, mode, credentialRefs))
        throw new ConflictError(
          'A scanner credential has been retired and cannot be reused.',
          'PASS_REISSUE_REQUIRED',
        );
      if (p.reservedPassId !== undefined)
        throw new ConflictError(
          'The retained connection item changed. Retry the sync.',
          'PASS_CONFLICT',
        );
      if (p.execution.kind === 'tenant' && p.execution.sampleScannerScope !== undefined)
        throw new ConflictError(
          'The scanner or its scope changed. Reload and retry.',
          'PASS_CONFLICT',
        );
      if (p.execution.kind === 'deferred' && p.execution.guard) {
        const taken = await livePassesBy(db, p.orgId, mode, 'external_id', [
          p.execution.guard.externalId,
        ]);
        if (taken.length > 0)
          throw new ConflictError('Another pass already has this External ID.', 'CREATE_STALE');
      }
      throw releaseChanged();
    }
    issuedOwnerUserId = inserted.ownerUserId;
    issuedRevision = inserted.revision;
  } catch (error) {
    const info = classifyD1Error(error, { triggers: true });
    // A failed D1 response can conceal a committed batch. Only delete when no INSERT was
    // attempted, the CAS definitely lost, or SQLite reported a definite rolled-back error.
    // A grant refusal rolled the batch back, so the artifact is unreferenced.
    if (!insertInFlight || info || createRefusal(error) !== null)
      await ctx.env.BUCKET.delete(objectKey);
    if (info?.kind === 'unique' && /passes\.(identity_id|download_token)/.test(info.detail))
      throw new ConflictError('That serial is already in use.', 'SERIAL_TAKEN');
    if (info?.kind === 'unique' && /passes\.external_ref/.test(info.detail))
      throw new ConflictError('That connection ref already has a pass.', 'PASS_REF_TAKEN');
    throw error;
  }
  writeEvent(ctx.env, {
    event: 'pass.issued',
    orgId: p.orgId,
    templateId: template.id,
    identityId: identity.id,
    mode,
  });
  const sending = Boolean(p.sendEmail && holderEmail);
  if (sending) await scheduleRequiredIssuanceDelivery(ctx, id);
  const pass = await getPass(db, id);
  if (!pass) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  if (
    holderEmail &&
    !sending &&
    (pass.orgId !== p.orgId ||
      pass.mode !== mode ||
      pass.status !== 'active' ||
      pass.removedAt !== null ||
      pass.deletedAt !== null ||
      pass.testDataQuarantined ||
      pass.version !== 1 ||
      pass.revision !== issuedRevision ||
      pass.linkGeneration !== 1 ||
      pass.credentialGeneration !== 1 ||
      pass.lifecycleGeneration !== 0 ||
      pass.ownerUserId !== issuedOwnerUserId ||
      pass.identityId !== identity.id ||
      pass.templateId !== template.id ||
      pass.templateVersion !== template.version ||
      pass.releaseId !== release.id ||
      pass.serial !== serial ||
      pass.authToken !== authToken.mac ||
      pass.downloadToken !== downloadToken.mac ||
      pass.webServiceUrl !== webServiceUrl ||
      pass.scanCode !== scanCode ||
      pass.objectKey !== objectKey ||
      pass.objectSha256 !== artifact.sha256 ||
      pass.connectionId !== (p.connectionId ?? null) ||
      pass.externalRef !== (p.externalRef ?? null) ||
      pass.holderEmail !== holderEmail)
  )
    throw new ConflictError('The pass changed before delivery.', 'PASS_CONFLICT');
  const tenant = p.execution.kind === 'tenant' ? p.execution : undefined;
  await assertPassDetailReadable(
    ctx,
    pass,
    tenant?.authority,
    undefined,
    tenant?.additionalAuthority,
  );
  return pass;
}
