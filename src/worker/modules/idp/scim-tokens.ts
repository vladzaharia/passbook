import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  flipToActive,
  insertPending,
  purgeRetired,
  retireStalePending,
} from './repo-scim-tokens.ts';

/** A pending token is accepted this long: Polaris ID may push between the write of the token and the flip. */
export const PENDING_WINDOW_MS = 2 * 3_600_000;
const RETIRED_KEEP_MS = 30 * 86_400_000;

export const hashScimToken = (token: string) => sha256Hex(token);

/**
 * Mints a token and records its hash as pending, retiring an older pending one. The caller hands the returned
 * plaintext to Polaris ID and never stores or logs it.
 */
export async function mintScimToken(
  ctx: ServiceContext,
  actor: string,
): Promise<{ id: string; token: string }> {
  const token = ctx.ids.token();
  const id = ctx.ids.id();
  await insertPending(ctx.env.DB, {
    id,
    sha256: await hashScimToken(token),
    now: ctx.clock.now(),
    createdBy: actor,
  });
  return { id, token };
}

/** Makes the pending token `id` the active one and retires the old active token. False when `id` is not pending. */
export const activateScimToken = (ctx: ServiceContext, id: string) =>
  flipToActive(ctx.env.DB, id, ctx.clock.now());

/** Daily hook `idp.scim_tokens`: retires pending tokens past their window, removes retired ones after 30 days. */
export async function dailyScimTokens(ctx: ServiceContext): Promise<void> {
  const now = ctx.clock.now();
  await retireStalePending(ctx.env.DB, now - PENDING_WINDOW_MS, now);
  await purgeRetired(ctx.env.DB, now - RETIRED_KEEP_MS);
}
