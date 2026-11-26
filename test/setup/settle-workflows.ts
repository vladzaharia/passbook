import { env } from 'cloudflare:workers';
import { afterEach } from 'vitest';

/**
 * A workflow instance started through a real binding runs in workerd and loads the Worker entry lazily.
 * When it outlives the test file, Vitest has already torn the environment down and logs an
 * EnvironmentTeardownError. Track what each test starts and wait for it to end; one that never ends fails
 * the test that started it.
 */
const SETTLE_MS = 20_000;
const started: WorkflowInstance[] = [];
const bindings = env as unknown as Record<string, unknown>;

/** The `workflows` bindings of test/wrangler.vitest.jsonc. */
const WORKFLOW_BINDINGS = [
  'TEMPLATE_IMPORT',
  'BULK_REISSUE',
  'BROADCAST',
  'IDENTITY_PROVISION',
  'CHANNEL_APPLY',
  'ORG_EXPORT',
  'ORG_PURGE',
  'PASS_IMPORT',
  'CONNECTION_SYNC',
] as const;

for (const name of WORKFLOW_BINDINGS) {
  const binding = bindings[name];
  if (!binding) continue;
  const real = binding as Workflow;
  Object.defineProperty(bindings, name, {
    configurable: true,
    enumerable: true,
    value: {
      create: async (options?: WorkflowInstanceCreateOptions) => {
        const instance = await real.create(options);
        started.push(instance);
        return instance;
      },
      createBatch: async (batch: WorkflowInstanceCreateOptions[]) => {
        const instances = await real.createBatch(batch);
        started.push(...instances);
        return instances;
      },
      get: (id: string) => real.get(id),
    },
  });
}

const ENDED = new Set(['complete', 'errored', 'terminated']);

afterEach(async () => {
  const pending = started.splice(0);
  const deadline = Date.now() + SETTLE_MS;
  const running: string[] = [];
  for (const instance of pending) {
    let status = (await instance.status()).status;
    while (!ENDED.has(status) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      status = (await instance.status()).status;
    }
    if (!ENDED.has(status)) {
      running.push(`${instance.id} (${status})`);
      await instance.terminate().catch(() => {});
    }
  }
  if (running.length > 0) {
    throw new Error(`workflow instances still running after the test: ${running.join(', ')}`);
  }
});
