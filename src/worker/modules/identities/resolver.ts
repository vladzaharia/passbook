import type { AppEnv } from '../../platform/env.ts';
import { createDbIdentityResolver } from './db-resolver.ts';
import type { IdentityResolver } from './env-identity.ts';

export {
  type IdentityResolver,
  PLATFORM_IDENTITY_ID,
  readEnvIdentity,
} from './env-identity.ts';

/** Resolves the env platform identity and DB (uploaded) identities, and org defaults. */
export function createIdentityResolver(env: AppEnv): IdentityResolver {
  return createDbIdentityResolver(env);
}

/** Same resolver; kept for callers written against the foundation name. */
export const createEnvIdentityResolver = createIdentityResolver;
