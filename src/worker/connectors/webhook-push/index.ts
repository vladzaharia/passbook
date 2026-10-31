import { z } from 'zod';
import { NotImplementedError } from '../../platform/errors.ts';
import type { ConnectorDefinition } from '../types.ts';

const config = z.object({ signatureHeader: z.string().default('x-wallet-signature') });
const secrets = z.object({ signingSecret: z.string().min(16) });

/** Records arrive in the signed webhook body; nothing is fetched. Owner: connections agent. */
const definition: ConnectorDefinition<z.infer<typeof config>, z.infer<typeof secrets>> = {
  type: 'webhook-push',
  version: 1,
  displayName: 'Webhook push',
  capabilities: { webhook: true },
  configSchema: config,
  secretSchema: secrets,
  outputFields: {},
  defaults: { intervalSeconds: 3600, maxConcurrency: 1, requestsPerMinute: 60, timeoutMs: 15_000 },
  async fetchRecord() {
    throw new NotImplementedError('webhook-push is not implemented yet.');
  },
};
export default definition;
