import type { IdentityDto } from '../../../shared/contracts/identities.ts';
import type { Actor } from '../../platform/context.ts';
import { encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import { batch } from '../../platform/db.ts';
import { ConflictError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditStmt } from '../audit/repo.ts';
import { auditActor } from '../audit/service.ts';
import { dropTeamApnsTokens } from '../delivery/apns-jwt.ts';
import { invalid } from './cert.ts';
import { apnsBindingPresent } from './db-resolver.ts';
import { checkKeyId, readP8 } from './push-key.ts';
import { clearPushKeyCache, pushKeyAad } from './push-key-store.ts';
import { getIdentityRow, type IdentityRow } from './repo.ts';
import {
  deletePushKeyStmt,
  getPushKeyMeta,
  replacePushKeyStmt,
  resetApnsHealth,
  teamIdentityBindings,
} from './repo-push-keys.ts';
import { getIdentity } from './service.ts';

/** Only identities that push with the key lose their health; certificate-bound ones keep theirs. */
async function resetKeyUsers(ctx: ServiceContext, team: string): Promise<void> {
  const rows = await teamIdentityBindings(ctx.env.DB, team);
  await resetApnsHealth(
    ctx.env.DB,
    rows.filter((r) => !apnsBindingPresent(ctx.env, r.apns_binding)).map((r) => r.id),
  );
}

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
  const replaced = (await getPushKeyMeta(ctx.env.DB, team)) !== null;
  await batch(ctx.env.DB, [
    replacePushKeyStmt(ctx.env.DB, {
      id,
      team,
      keyId,
      kekVersion: envelope.kekVersion,
      iv: envelope.iv,
      wrappedDek: envelope.wrappedDek,
      ciphertext: envelope.ciphertext,
      createdBy: actor.type === 'user' ? actor.id : null,
      now: ctx.clock.now(),
    }),
    auditStmt(ctx.env.DB, ctx, {
      ...auditActor(actor),
      orgId: row.org_id,
      action: replaced ? 'identity.push_key_rotate' : 'identity.push_key_set',
      targetType: 'identity',
      targetId: identityId,
      detail: { teamIdentifier: team, keyId },
    }),
  ]);
  await resetKeyUsers(ctx, team);
  clearPushKeyCache();
  dropTeamApnsTokens(team);
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
  if (!meta) throw new ConflictError('This team has no push key.', 'PUSH_KEY_NONE');
  await batch(ctx.env.DB, [
    deletePushKeyStmt(ctx.env.DB, team),
    auditStmt(ctx.env.DB, ctx, {
      ...auditActor(actor),
      orgId: row.org_id,
      action: 'identity.push_key_remove',
      targetType: 'identity',
      targetId: identityId,
      detail: { teamIdentifier: team, keyId: meta.key_id },
    }),
  ]);
  await resetKeyUsers(ctx, team);
  clearPushKeyCache();
  dropTeamApnsTokens(team);
  return getIdentity(ctx, identityId);
}
