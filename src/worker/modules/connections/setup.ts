import { RecipeIdSchema } from '../../../shared/contracts/connections.ts';
import type { ConnectionSetup } from '../../../shared/contracts/index.ts';
import { SETUP_GUIDES } from '../../connectors/webhook-push/recipes/index.ts';
import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { webhookUrl } from './dto.ts';
import { requireConnection } from './service-shared.ts';

const WEBHOOK_PUSH = 'webhook-push';
/** What the custom scheme signs with when the connection names no header (inbound-headers.ts). */
const DEFAULTS = { signatureHeader: 'x-wallet-signature', timestampHeader: 'x-wallet-timestamp' };

/**
 * The sender's setup guide with this connection's values filled in. Authorize the connection's org first.
 * A secret is never part of it: only whether one is stored.
 */
export async function connectionSetup(
  sctx: ServiceContext,
  id: string,
  authorize: (orgId: string) => Promise<unknown>,
): Promise<ConnectionSetup> {
  const conn = await requireConnection(sctx, id);
  await authorize(conn.orgId);
  if (conn.connectorType !== WEBHOOK_PUSH) {
    throw new NotFoundError('This connection has no setup guide.', 'CONNECTOR_NOT_FOUND');
  }
  const recipe = RecipeIdSchema.catch('custom').parse(conn.config.recipe);
  const custom = recipe === 'custom';
  const header = (key: keyof typeof DEFAULTS) => {
    const configured = conn.config[key];
    return custom ? (typeof configured === 'string' ? configured : DEFAULTS[key]) : null;
  };
  return {
    ...SETUP_GUIDES[recipe],
    values: {
      endpointUrl: webhookUrl(sctx.env, conn),
      signatureHeader: header('signatureHeader'),
      timestampHeader: header('timestampHeader'),
      hasSecret: conn.webhookCredentialId !== null,
    },
  };
}
