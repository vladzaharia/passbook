import { z } from 'zod';
import type { ConnectorDefinition } from '../types.ts';

const config = z.object({ seed: z.string().default('demo') });

/** Deterministic fake upstream for local dev, e2e and demos. Owner: connections agent. */
const definition: ConnectorDefinition<z.infer<typeof config>, undefined> = {
  type: 'demo',
  version: 1,
  displayName: 'Demo',
  capabilities: { poll: true },
  configSchema: config,
  outputFields: {
    memberName: { type: 'string' },
    memberId: { type: 'string' },
    status: { type: 'string' },
  },
  defaults: { intervalSeconds: 60, maxConcurrency: 4, requestsPerMinute: 600, timeoutMs: 5_000 },
  async fetchRecord(_ctx, ref) {
    return {
      status: 'ok',
      record: { memberName: `Member ${ref}`, memberId: ref, status: 'active' },
    };
  },
};
export default definition;
