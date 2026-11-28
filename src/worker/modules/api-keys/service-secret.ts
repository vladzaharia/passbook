import { type ApiKeyKind, secretLabel } from '../../platform/api-key-token.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';

/** A CLI sign-in's key: its secret tail is derived from the session, so the poll that wins can hand it over. */
export interface CliMint {
  tail(prefix: string): Promise<string>;
}

/** A fresh secret: shown once, stored only as its hash. */
export async function newSecret(
  ctx: ServiceContext,
  kind: ApiKeyKind,
  mode: 'live' | 'test',
  cli?: CliMint,
) {
  const prefix = ctx.ids.token(6);
  const label = secretLabel(kind, mode, cli ? 'cli' : 'app');
  const secret = `${label}_${prefix}_${cli ? await cli.tail(prefix) : ctx.ids.token(32)}`;
  return { prefix, label, secret, hash: await sha256Hex(secret) };
}
