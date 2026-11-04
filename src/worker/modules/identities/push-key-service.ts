import type { IdentityDto } from '../../../shared/contracts/identities.ts';
import type { Actor } from '../../platform/context.ts';
import { encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import { ConflictError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditActor, recordAudit } from '../audit/service.ts';
import { clearApnsTokens } from '../delivery/apns-jwt.ts';
import { invalid } from './cert.ts';
import { checkKeyId, readP8 } from './push-key.ts';
import { clearPushKeyCache, pushKeyAad } from './push-key-store.ts';
import { getIdentityRow, type IdentityRow } from './repo.ts';
import {
  deletePushKey,
  getPushKeyMeta,
  replacePushKey,
  resetTeamApnsHealth,
} from './repo-push-keys.ts';
import { getIdentity } from './service.ts';

async function teamRow(ctx: ServiceContext, identityId: string): Promise<IdentityRow> {
  const row = await getIdentityRow(ctx.env.DB, identityId);
  if (!row) throw new NotFoundError('Signing identity not found.', 'IDENTITY_NOT_FOUND');
  if (!row.team_identifier)
    throw invalid(
      'This identity has no team ID, so a push key cannot be attached.',
      'PUSH_KEY_TEAM',
    );
  return row;
}

/** Stores or replaces the push key of the identity's team. One key serves every identity of the team. */
export async function setPushKey(
  ctx: ServiceContext,
  actor: Actor,
  identityId: string,
  input: { keyId: string; p8: string },
): Promise<IdentityDto> {
  const row = await teamRow(ctx, identityId);
  const team = row.team_identifier;
  const keyId = checkKeyId(input.keyId);
  const der = await readP8(input.p8);
  const id = ctx.ids.id();
  const envelope = await encryptSecret(await loadKekRing(ctx.env), der, pushKeyAad(id, team));
  const replaced = await replacePushKey(ctx.env.DB, {
    id,
    team,
    keyId,
    kekVersion: envelope.kekVersion,
    iv: envelope.iv,
    wrappedDek: envelope.wrappedDek,
    ciphertext: envelope.ciphertext,
    createdBy: actor.type === 'user' ? actor.id : null,
    now: ctx.clock.now(),
  });
  await resetTeamApnsHealth(ctx.env.DB, team);
  clearPushKeyCache();
  clearApnsTokens();
  await recordAudit(ctx, {
    ...auditActor(actor),
    orgId: row.org_id,
    action: replaced ? 'identity.push_key_rotate' : 'identity.push_key_set',
    targetType: 'identity',
    targetId: identityId,
    detail: { teamIdentifier: team, keyId },
  });
  return getIdentity(ctx, identityId);
}

export async function removePushKey(
  ctx: ServiceContext,
  actor: Actor,
  identityId: string,
): Promise<IdentityDto> {
  const row = await teamRow(ctx, identityId);
  const team = row.team_identifier;
  const meta = await getPushKeyMeta(ctx.env.DB, team);
  if (!meta || !(await deletePushKey(ctx.env.DB, team)))
    throw new ConflictError('This team has no push key.', 'PUSH_KEY_NONE');
  await resetTeamApnsHealth(ctx.env.DB, team);
  clearPushKeyCache();
  clearApnsTokens();
  await recordAudit(ctx, {
    ...auditActor(actor),
    orgId: row.org_id,
    action: 'identity.push_key_remove',
    targetType: 'identity',
    targetId: identityId,
    detail: { teamIdentifier: team, keyId: meta.key_id },
  });
  return getIdentity(ctx, identityId);
}
