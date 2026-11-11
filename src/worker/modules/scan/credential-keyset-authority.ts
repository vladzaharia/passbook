import type { SqlValue } from '../../platform/db.ts';
import { UnavailableError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  captureCredentialKeyEnv,
  credentialRefKeysetCommitment,
} from '../passes/credential-keyset.ts';
import { credentialRefKeysetInitializeStmt } from '../passes/repo-credential-keyset.ts';
import { credentialKeysetAuthorityStmt } from './repo-credential-keyset-authority.ts';

/** Pin the request's complete KEK ring without changing its other service bindings. */
export function credentialKeysetContext(ctx: ServiceContext): ServiceContext {
  const keys = captureCredentialKeyEnv(ctx.env);
  const env = { ...ctx.env } as typeof ctx.env & Record<string, unknown>;
  for (const name of Object.keys(env)) if (/^KEK_V\d+$/.test(name)) delete env[name];
  Object.assign(env, keys);
  return { ...ctx, env: Object.freeze(env) };
}

/** Capture an authorized keyset and bootstrap it only in the same authorized D1 transaction. */
export async function captureCredentialKeyset(
  ctx: ServiceContext,
  guard: { sql: string; params: readonly SqlValue[] },
): Promise<string | null> {
  const db = ctx.env.DB;
  const commitment = await credentialRefKeysetCommitment(captureCredentialKeyEnv(ctx.env));
  const [, result] = await db.batch<{ authorized: number; matches: number }>([
    credentialRefKeysetInitializeStmt(db, commitment, guard),
    credentialKeysetAuthorityStmt(db, commitment, guard),
  ]);
  const row = result?.results[0];
  if (!row?.authorized) return null;
  if (row.matches !== 1)
    throw new UnavailableError(
      'Credential references are unavailable.',
      'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
    );
  return commitment;
}
