import type { ServiceContext } from '../../platform/service-context.ts';
import { captureCredentialKeyEnv } from '../passes/credential-keyset.ts';

/** Keep key derivation and envelope operations on one pre-await KEK snapshot. */
export function pinWebhookKeyContext(sctx: ServiceContext): ServiceContext {
  const keys = captureCredentialKeyEnv(sctx.env);
  const env = { ...sctx.env };
  for (const name of Object.keys(env)) {
    if (/^KEK_V\d+$/.test(name)) delete (env as Record<string, unknown>)[name];
  }
  Object.assign(env, keys);
  return { ...sctx, env: Object.freeze(env) };
}
