import { z } from 'zod';
import { NotImplementedError } from '../../platform/errors.ts';
import type { ConnectorDefinition } from '../types.ts';

const config = z.object({
  baseUrl: z.url(),
  recordPath: z.string().default('/{ref}'),
});
const secrets = z.object({ token: z.string().optional() });

/** Per-record GET with optional list/delta endpoint and optional HMAC webhook. Owner: connections agent. */
const definition: ConnectorDefinition<z.infer<typeof config>, z.infer<typeof secrets>> = {
  type: 'http-json',
  version: 1,
  displayName: 'HTTP JSON',
  capabilities: { poll: true, delta: true, webhook: true },
  configSchema: config,
  secretSchema: secrets,
  outputFields: {},
  defaults: { intervalSeconds: 900, maxConcurrency: 4, requestsPerMinute: 60, timeoutMs: 15_000 },
  async fetchRecord() {
    throw new NotImplementedError('http-json is not implemented yet.');
  },
};
export default definition;
