import type { AnyConnector } from '../../connectors/types.ts';
import { keyedDigest } from '../../platform/crypto.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { secretFingerprintTaken } from './repo-credentials.ts';

/** A recipe whose sender makes the secret, so the admin pastes it (Shopify, Stripe). */
export function pastesSecret(def: AnyConnector, config: unknown): boolean {
  const recipe = (config as { recipe?: unknown } | null)?.recipe;
  return def.recipes?.some((r) => r.id === recipe && r.pasteSecret) ?? false;
}

/** Keyed hash of a pasted secret; unique platform-wide, current or still-overlapping (connections.webhook_*secret_fp). */
export function secretFingerprint(sctx: ServiceContext, secret: string): Promise<string> {
  return keyedDigest(sctx.env, 'connection.webhook-secret-fp.v1', secret);
}

/** The same answer whoever holds the secret: it must not confirm that a secret is live elsewhere. */
function refused(sctx: ServiceContext, where: string): never {
  sctx.log.info('connection.webhook_secret_refused', { code: 'WEBHOOK_SECRET_REUSED', where });
  throw new ValidationError('This signing secret cannot be used.', [
    { path: 'webhookSecret', message: 'Not allowed.' },
  ]);
}

/** Refuses a fingerprint held by another connection as its current or previous secret. */
export async function assertSecretFree(
  sctx: ServiceContext,
  fp: string,
  ownConnectionId: string | null,
): Promise<void> {
  const taken = await secretFingerprintTaken(sctx.env.DB, fp, ownConnectionId);
  if (taken) refused(sctx, 'check');
}

/** Turns the unique-index violation (a race past the check) into the same answer. Rethrows anything else. */
export function rethrowSecretReuse(sctx: ServiceContext, error: unknown): never {
  if (classifyD1Error(error)?.detail?.includes('secret_fp')) refused(sctx, 'index');
  throw error;
}
