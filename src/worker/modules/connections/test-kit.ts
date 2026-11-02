import {
  type Fixtures,
  fixtures,
  makeEnv,
  makeOrg,
  makePass,
  makeTemplate,
  makeUser,
  type OrgRow,
  persistTemplate,
} from '../../../../test/helpers/index.ts';
import { PassBuildError } from '../../../passkit/build.ts';
import type { Job } from '../../jobs/types.ts';
import { ManualClock } from '../../platform/clock.ts';
import { run } from '../../platform/db.ts';
import { nullLogger } from '../../platform/log.ts';
import { createServiceContext, type ServiceContext } from '../../platform/service-context.ts';
import { type ConnectionDeps, resetDeps, setDeps } from './deps.ts';
import * as service from './service.ts';
import type { StepLike } from './sync-runner.ts';

type Create = Parameters<typeof service.create>[2];

export interface Seams {
  applied: Parameters<ConnectionDeps['applyConnectionRecord']>[1][];
  created: Parameters<ConnectionDeps['createPassFromConnection']>[1][];
  missing: { passId: string; mode: 'flag' | 'void' }[];
  pushes: { passId: string; reason: string }[];
  jobs: Job[];
  /** What applyConnectionRecord reports. */
  changed: boolean;
  failEnqueue: boolean;
  failPush: boolean;
}

export const publicResolver = { resolve: async () => ['93.184.216.34'] };

export interface Kit extends Fixtures {
  sctx: ServiceContext;
  org: OrgRow;
  templateId: string;
  seams: Seams;
  actor: { type: 'user'; id: string };
}

/** Env, org, persisted template and fake seams (passes, delivery, queue, DNS). */
export async function makeKit(): Promise<Kit> {
  const env = await makeEnv({ KEK_V1: btoa('0123456789abcdef0123456789abcdef') });
  const clock = new ManualClock();
  const f = fixtures(env, clock);
  const sctx = createServiceContext(env, { clock, log: nullLogger });
  const org = await makeOrg(f);
  const user = await makeUser(f);
  const template = makeTemplate({ id: `tpl-${org.id.slice(-8)}`, orgId: org.id });
  await persistTemplate(f, template.resolved);
  const seams: Seams = {
    applied: [],
    created: [],
    missing: [],
    pushes: [],
    jobs: [],
    changed: true,
    failEnqueue: false,
    failPush: false,
  };
  resetDeps();
  setDeps({
    applyConnectionRecord: async (_ctx, input) => {
      seams.applied.push(input);
      return { changed: seams.changed, version: 2 };
    },
    createPassFromConnection: async (_ctx, input) => {
      seams.created.push(input);
      return { passId: `new-${input.externalRef}` };
    },
    markPassMissing: async (_ctx, passId, mode) => {
      seams.missing.push({ passId, mode });
    },
    enqueuePush: async (_ctx, passId, reason) => {
      if (seams.failPush) throw new Error('push down');
      seams.pushes.push({ passId, reason });
    },
    enqueueJob: async (_ctx, job) => {
      if (seams.failEnqueue) throw new Error('queue down');
      seams.jobs.push(job);
    },
    validateFields: async (_ctx, _template, fields) => {
      if (typeof fields.memberName !== 'string' || fields.memberName === '') {
        throw new PassBuildError('INVALID_INPUT', 'The pass input is invalid.', []);
      }
    },
    sleep: async () => {},
    resolver: publicResolver,
  });
  return {
    ...f,
    sctx,
    org,
    templateId: template.resolved.id,
    seams,
    actor: { type: 'user', id: user.id },
  };
}

export function demoInput(kit: Kit, overrides: Partial<Create> = {}): Create {
  return {
    orgId: kit.org.id,
    connectorType: 'demo',
    name: 'Demo',
    config: { count: 3 },
    mode: 'poll',
    ...overrides,
  } as Create;
}

export async function createDemo(kit: Kit, overrides: Partial<Create> = {}) {
  return service.create(kit.sctx, kit.actor, demoInput(kit, overrides));
}

/** A pass bound to `ref` on the connection (inserted through the shared test factory). */
export async function linkedPass(kit: Kit, connectionId: string, ref: string, orgId = kit.org.id) {
  const template = makeTemplate({ id: kit.templateId, orgId });
  const pass = await makePass(kit, { orgId, template: template.resolved });
  await run(kit.env.DB, 'UPDATE passes SET connection_id = ?, external_ref = ? WHERE id = ?', [
    connectionId,
    ref,
    pass.id,
  ]);
  return pass;
}

export function inlineStep(): StepLike & { names: string[]; sleeps: number[] } {
  const names: string[] = [];
  const sleeps: number[] = [];
  return {
    names,
    sleeps,
    do: async (name, fn) => {
      names.push(name);
      // Workflow steps persist JSON; round-trip to catch non-serializable results.
      const value = await fn();
      return value === undefined ? value : JSON.parse(JSON.stringify(value));
    },
    sleep: async (_name, ms) => {
      sleeps.push(ms);
    },
  };
}

/** A service context whose CONNECTION_SYNC binding records instead of starting workflows. */
export function withWorkflow(
  kit: Kit,
  create?: (options: unknown) => Promise<void>,
  /** What `get(id).status()` reports; unset makes `get` throw, like an unknown instance. */
  status?: () => string,
) {
  const created: { id: string; params: Record<string, unknown> }[] = [];
  const binding = {
    get: async () => {
      if (!status) throw new Error('instance.not_found');
      return { status: async () => ({ status: status() }) };
    },
    create: async (options: { id: string; params: Record<string, unknown> }) => {
      if (create) await create(options);
      created.push(options);
    },
  };
  const sctx = {
    ...kit.sctx,
    env: { ...kit.env, CONNECTION_SYNC: binding },
  } as unknown as ServiceContext;
  return { sctx, created };
}
