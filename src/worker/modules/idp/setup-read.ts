import type { SetupItem } from '../../../shared/contracts/idp-setup.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { idpClient, idpConfigured } from './client.ts';
import { idpCodeOf } from './errors.ts';
import { countGroups, countUsers } from './repo-scim.ts';
import { activeToken } from './repo-scim-tokens.ts';
import { bindingDown, itemsOf } from './setup-items.ts';
import type { IdpRpc } from './types.ts';

export interface SetupView {
  mode: 'dry_run' | 'live' | null;
  items: SetupItem[];
  /** A SCIM connection exists in Polaris ID (false when it could not be read). */
  scimExists: boolean;
}

/**
 * One health read and one setup read, with the token table and the directory mirror: the item matrix. Nothing
 * is written, and the token hash only goes to the binding to be compared.
 */
export async function readSetup(ctx: ServiceContext, rpc?: IdpRpc): Promise<SetupView> {
  if (!idpConfigured(ctx.env))
    return { mode: null, items: bindingDown('binding_absent', true), scimExists: false };
  const client = rpc ?? idpClient(ctx.env, ctx.log);
  const db = ctx.env.DB;
  const active = await activeToken(db);
  let reads: Awaited<ReturnType<typeof readBinding>>;
  try {
    reads = await readBinding(client, active?.token_sha256);
  } catch (error) {
    const code = idpCodeOf(error);
    ctx.log.warn('idp.setup.read_failed', { code: code ?? 'IDP_UNAVAILABLE' });
    return code === 'IDP_AUTH'
      ? { mode: null, items: bindingDown('idp_auth', true), scimExists: false }
      : { mode: null, items: bindingDown('binding_unreachable', false), scimExists: false };
  }
  const { health, status } = reads;
  if (health.frozen || !status)
    return { mode: health.mode, items: bindingDown('frozen', true), scimExists: false };
  const items = itemsOf({
    health,
    status,
    token: { active: active !== null, lastAuthAt: active?.last_auth_at ?? null },
    mirror: { users: await countUsers(db), groups: await countGroups(db) },
    now: ctx.clock.now(),
  });
  return { mode: health.mode, items, scimExists: status.scim.exists };
}

/** Health first: a frozen binding is not asked for the setup read. */
async function readBinding(client: IdpRpc, hash: string | undefined) {
  const health = await client.health();
  if (health.frozen) return { health, status: null };
  return { health, status: await client.setupStatus({ tokenHashes: hash ? [hash] : [] }) };
}
