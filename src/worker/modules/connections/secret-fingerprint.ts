import type { AnyConnector } from '../../connectors/types.ts';
import { RECIPES } from '../../connectors/webhook-push/recipes/index.ts';
import { keyedDigest } from '../../platform/crypto.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { secretFingerprintHolders } from './repo-credentials.ts';

/** A recipe whose sender makes the secret, so the admin pastes it (Shopify, Stripe). */
export function pastesSecret(def: AnyConnector, config: unknown): boolean {
  const recipe = (config as { recipe?: unknown } | null)?.recipe;
  return def.recipes?.some((r) => r.id === recipe && r.pasteSecret) ?? false;
}

/** A recipe whose sender issues the secret after the URL exists: a new connection starts without one. */
export function awaitsProviderSecret(def: AnyConnector, config: unknown): boolean {
  const recipe = (config as { recipe?: unknown } | null)?.recipe;
  return def.recipes?.some((r) => r.id === recipe && r.secretOrigin === 'provider') ?? false;
}

/** A webhook connection with no secret yet that PassBook, not the sender, should make one for. */
export function needsGeneratedSecret(
  def: AnyConnector,
  conn: { webhookCredentialId: string | null; config: unknown },
  mode: string,
): boolean {
  return (
    (mode === 'webhook' || mode === 'hybrid') &&
    conn.webhookCredentialId === null &&
    !awaitsProviderSecret(def, conn.config)
  );
}

/** The verifier family of a recipe whose sender signs a whole account with one key, else null. */
function accountFamily(recipe: unknown): string | null {
  const r = RECIPES[recipe as keyof typeof RECIPES];
  return r?.secretScope === 'account' ? r.verifier : null;
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

/**
 * Refuses a fingerprint held by another connection as its current or previous secret. The exception is
 * an account-scoped recipe (Shopify): connections of the same family in the same org share one store key.
 */
export async function assertSecretFree(
  sctx: ServiceContext,
  fp: string,
  ownConnectionId: string | null,
  share: { orgId: string; config: unknown },
): Promise<void> {
  const holders = await secretFingerprintHolders(sctx.env.DB, fp, ownConnectionId);
  if (holders.length === 0) return;
  const family = accountFamily((share.config as { recipe?: unknown } | null)?.recipe);
  if (family && holders.every((h) => h.orgId === share.orgId && accountFamily(h.recipe) === family))
    return;
  refused(sctx, 'check');
}

/** Turns the unique-index violation (a race past the check) into the same answer. Rethrows anything else. */
export function rethrowSecretReuse(sctx: ServiceContext, error: unknown): never {
  if (classifyD1Error(error)?.detail?.includes('secret_fp')) refused(sctx, 'index');
  throw error;
}
