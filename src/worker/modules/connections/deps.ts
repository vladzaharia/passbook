import { validateInput } from '../../../passkit/build.ts';
import type { Json } from '../../../shared/contracts/common.ts';
import type { Job } from '../../jobs/types.ts';
import { type DnsResolver, dohResolver } from '../../platform/safe-fetch.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { enqueueRefreshPush } from '../delivery/service.ts';
import {
  applyConnectionRecord,
  createPassFromConnection,
  markPassMissing,
} from '../passes/service.ts';
import { createTemplateRegistry } from '../templates/registry.ts';

/** Everything the sync engine reaches outside this module for. Tests replace pieces with `setDeps`. */
export interface ConnectionDeps {
  applyConnectionRecord: typeof applyConnectionRecord;
  createPassFromConnection: typeof createPassFromConnection;
  markPassMissing: typeof markPassMissing;
  enqueueRefreshPush: typeof enqueueRefreshPush;
  enqueueJob(ctx: ServiceContext, job: Job): Promise<void>;
  /** Throws when `fields` do not satisfy the template's input schema. */
  validateFields(
    ctx: ServiceContext,
    template: { id: string; version: string | null },
    fields: Record<string, Json>,
  ): Promise<void>;
  /** Pacing delay between request batches. */
  sleep(ms: number): Promise<void>;
  resolver: DnsResolver | undefined;
  fetchImpl: typeof fetch | undefined;
}

const real: ConnectionDeps = {
  applyConnectionRecord,
  createPassFromConnection,
  markPassMissing,
  enqueueRefreshPush,
  enqueueJob: async (ctx, job) => {
    await ctx.env.JOBS.send(job);
  },
  validateFields: async (ctx, template, fields) => {
    const resolved = await createTemplateRegistry(ctx.env).resolve(
      template.id,
      template.version ?? undefined,
    );
    validateInput(resolved, fields);
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  resolver: undefined,
  fetchImpl: undefined,
};

let current: ConnectionDeps = real;

export function getDeps(): ConnectionDeps {
  return current;
}

/** Test seam. */
export function setDeps(overrides: Partial<ConnectionDeps>): void {
  current = { ...current, ...overrides };
}

export function resetDeps(): void {
  current = real;
}

export function resolverOf(deps: ConnectionDeps): DnsResolver {
  return deps.resolver ?? dohResolver(deps.fetchImpl ?? fetch);
}
