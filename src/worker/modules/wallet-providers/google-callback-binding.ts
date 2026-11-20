import { baseUrl } from '../../platform/env.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  captureCredentialKeyEnv,
  requireCredentialRefKeyset,
} from '../passes/credential-keyset.ts';
import type { GoogleGenericProjection } from './google-projection.ts';
import {
  type GoogleCallbackBindingInput,
  isGoogleCallbackBindingCurrent,
  putGoogleCallbackBinding,
} from './repo-google-callback.ts';
import { googleRuntimeIdHashes, type WalletRuntimeScope } from './runtime.ts';
import { copyRuntimeScope, runtimeAccountUnavailable } from './runtime-core.ts';

/** Build the callback URL from configuration only; publishing still requires the guarded helper. */
export function googleCallbackUrl(ctx: ServiceContext, accountId: string): string {
  try {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(accountId)) throw new Error();
    const origin = new URL(baseUrl(ctx.env));
    if (
      origin.protocol !== 'https:' ||
      origin.username ||
      origin.password ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash
    )
      throw new Error();
    return `${origin.origin}/wallet/v1/google/${accountId}`;
  } catch {
    throw runtimeAccountUnavailable();
  }
}

/** Register the hash-indexed lookup under the exact approved current operation. */
export async function registerGoogleCallbackBinding(
  ctx: ServiceContext,
  scope: WalletRuntimeScope,
  input: GoogleCallbackBindingInput,
): Promise<void> {
  try {
    const credentialKeyEnv = captureCredentialKeyEnv(ctx.env);
    const pinnedCtx: ServiceContext = {
      ...ctx,
      env: Object.freeze({ ...ctx.env, ...credentialKeyEnv }),
    };
    const capturedScope = copyRuntimeScope(scope);
    const capturedInput = { ...input };
    await requireCredentialRefKeyset(ctx.env.DB, credentialKeyEnv);
    const hashes = await googleRuntimeIdHashes(pinnedCtx, capturedScope, {
      releaseId: capturedInput.releaseId,
      passId: capturedInput.passId,
      credentialGeneration: capturedInput.credentialGeneration,
      channelEpoch: capturedInput.channelEpoch,
    });
    if (
      !(await putGoogleCallbackBinding(
        ctx.env.DB,
        capturedScope,
        capturedInput,
        hashes,
        ctx.clock.now(),
      ))
    )
      throw runtimeAccountUnavailable();
    if (
      !(await isGoogleCallbackBindingCurrent(
        ctx.env.DB,
        capturedScope,
        capturedInput,
        hashes,
        ctx.clock.now(),
      ))
    )
      throw runtimeAccountUnavailable();
  } catch {
    // Do not propagate database/provider exceptions with identifiers or credential material.
    throw runtimeAccountUnavailable();
  }
}

/** Merge into the approved GenericClass before any offer or provider class publication. */
export async function googleCallbackClassProjection(
  ctx: ServiceContext,
  scope: WalletRuntimeScope,
  input: GoogleCallbackBindingInput,
): Promise<GoogleGenericProjection> {
  const capturedScope = copyRuntimeScope(scope);
  const url = googleCallbackUrl(ctx, capturedScope.accountId);
  await registerGoogleCallbackBinding(ctx, capturedScope, { ...input });
  return { callbackOptions: { url } };
}
