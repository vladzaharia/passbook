import {
  createFakeApns,
  createFakeMailer,
  type FakeApns,
  type FakeMailer,
  type Fixtures,
  fixtures,
  makeEnv,
  makeOrg,
  makeTemplate,
  type OrgRow,
  persistTemplate,
} from '../../../../test/helpers/index.ts';
import type { InMemoryTemplateRegistry } from '../../../passkit/template/in-memory-registry.ts';
import type { ResolvedTemplate } from '../../../passkit/template/registry.ts';
import { ManualClock } from '../../platform/clock.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext, type ServiceContext } from '../../platform/service-context.ts';
import { ensurePlatformIdentity } from '../identities/repo.ts';
import { createPassRow } from './create.ts';
import { overrideDeps } from './deps.ts';
import type { Pass } from './repo.ts';

export interface FakeQueue {
  sent: unknown[];
  fail: boolean;
  send(message: unknown): Promise<void>;
  sendBatch(batch: { body: unknown }[]): Promise<void>;
}

export function createFakeQueue(): FakeQueue {
  const queue: FakeQueue = {
    sent: [],
    fail: false,
    async send(message) {
      if (queue.fail) throw new Error('queue down');
      queue.sent.push(message);
    },
    async sendBatch(batch) {
      if (queue.fail) throw new Error('queue down');
      queue.sent.push(...batch.map((m) => m.body));
    },
  };
  return queue;
}

export interface Kit {
  env: AppEnv;
  clock: ManualClock;
  fx: Fixtures;
  ctx: ServiceContext;
  org: OrgRow;
  template: ResolvedTemplate;
  registry: InMemoryTemplateRegistry;
  apns: FakeApns;
  mailer: FakeMailer;
  queue: FakeQueue;
  /** Creates a pass through the real service. */
  pass(input?: { memberName?: string; holderEmail?: string; orgId?: string }): Promise<Pass>;
}

/** Real D1/R2 with fake queue, APNs, mailer and an in-memory template registry. */
export async function setupKit(): Promise<Kit> {
  const queue = createFakeQueue();
  const env = await makeEnv({ JOBS: queue as unknown as Queue });
  const clock = new ManualClock(Date.now());
  const fx = fixtures(env, clock);
  const { resolved, registry } = makeTemplate({ id: `tpl-${fx.ids.token(4)}` });
  const apns = createFakeApns();
  const mailer = createFakeMailer();
  overrideDeps(env, { registry, apns, mailer });
  await ensurePlatformIdentity(env, clock.now());
  const org = await makeOrg(fx, { name: 'Test Gym' });
  await persistTemplate(fx, resolved);
  const ctx = createServiceContext(env, { clock });
  return {
    env,
    clock,
    fx,
    ctx,
    org,
    template: resolved,
    registry,
    apns,
    mailer,
    queue,
    async pass(input = {}) {
      return createPassRow(ctx, {
        orgId: input.orgId ?? org.id,
        templateId: resolved.id,
        input: { memberName: input.memberName ?? 'Alex Morgan' },
        holderEmail: input.holderEmail ?? null,
        source: 'manual',
        actor: { type: 'system', id: null },
      });
    },
  };
}
