import type { AppEnv } from '../../platform/env.ts';
import { apnsBindingPresent } from './db-resolver.ts';

export type PushMethod = 'certificate' | 'key' | 'none';

/** How an identity pushes: its mTLS binding when present, else its team's push key, else not at all. */
export function pushMethodOf(
  env: AppEnv,
  apnsBinding: string | null,
  teamHasKey: boolean,
): PushMethod {
  if (apnsBindingPresent(env, apnsBinding)) return 'certificate';
  return teamHasKey ? 'key' : 'none';
}
