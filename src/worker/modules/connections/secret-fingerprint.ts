import type { AnyConnector } from '../../connectors/types.ts';
import { keyedDigest } from '../../platform/crypto.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';

/** A recipe whose sender makes the secret, so the admin pastes it (Shopify, Stripe). */
export function pastesSecret(def: AnyConnector, config: unknown): boolean {
  const recipe = (config as { recipe?: unknown } | null)?.recipe;
  return def.recipes?.some((r) => r.id === recipe && r.pasteSecret) ?? false;
}

/** Keyed hash of a pasted secret; unique platform-wide (connections.webhook_secret_fp). */
export function secretFingerprint(sctx: ServiceContext, secret: string): Promise<string> {
  return keyedDigest(sctx.env, 'connection.webhook-secret-fp.v1', secret);
}

/** Turns the unique-index violation into the answer the admin needs. Rethrows anything else. */
export function rethrowSecretReuse(error: unknown): never {
  if (classifyD1Error(error)?.detail?.includes('webhook_secret_fp')) {
    throw new ValidationError('This signing secret is already used by another connection.', [
      { path: 'webhookSecret', message: 'Already in use.' },
    ]);
  }
  throw error;
}
