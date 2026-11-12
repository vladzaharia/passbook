import { ForbiddenError } from '../../platform/errors.ts';
import type {
  CredentialTransferAuthority,
  CredentialTransferTarget,
} from './repo-credential-transfer-read.ts';
import type { Actor } from './service.ts';

export function assertCredentialTransferActor(
  actor: Actor,
  authority: CredentialTransferAuthority,
  target: CredentialTransferTarget,
): void {
  const tenant =
    authority.kind === 'session' || authority.kind === 'api_key'
      ? authority
      : authority.kind === 'tenant-holder' || authority.kind === 'verified-attach'
        ? authority.authority
        : undefined;
  if (
    tenant &&
    (tenant.kind === 'session'
      ? actor.type !== 'user' || actor.id !== tenant.userId
      : actor.type !== 'api_key' || actor.id !== tenant.keyId)
  )
    throw new ForbiddenError();
  if (authority.kind === 'tenant-holder' && !tenant && actor.type !== 'system')
    throw new ForbiddenError();
  if (authority.kind === 'verified-attach') {
    if (
      target.ownerUserId !== authority.userId ||
      target.holderEmail !== authority.email ||
      (!tenant &&
        actor.type !== 'system' &&
        (actor.type !== 'user' || actor.id !== authority.userId) &&
        (actor.type !== 'connection' ||
          !authority.connection ||
          actor.id !== authority.connection.connectionId))
    )
      throw new ForbiddenError();
  }
  if (
    authority.kind === 'self-remove' &&
    (actor.type !== 'user' ||
      actor.id !== authority.userId ||
      target.ownerUserId !== null ||
      target.holderEmail !== authority.expected.holderEmail)
  )
    throw new ForbiddenError();
  if (
    authority.kind === 'connection' &&
    (actor.type !== 'connection' || actor.id !== authority.connection.connectionId)
  )
    throw new ForbiddenError();
}
