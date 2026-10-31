import { inflateSync } from 'fflate';
import { expect } from 'vitest';
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
import { crc32 } from '../../../passkit/index.ts';
import type { InMemoryTemplateRegistry } from '../../../passkit/template/in-memory-registry.ts';
import type { ResolvedTemplate } from '../../../passkit/template/registry.ts';
import { ManualClock } from '../../platform/clock.ts';
import type { AppEnv } from '../../platform/env.ts';
import { NotFoundError } from '../../platform/errors.ts';
import { createServiceContext, type ServiceContext } from '../../platform/service-context.ts';
import { addRegistration } from '../apple/repo.ts';
import { ensurePlatformIdentity } from '../identities/repo.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { createPassRow } from './create.ts';
import { overrideDeps } from './deps.ts';
import type { Pass } from './repo.ts';

/** 1x1 PNG. */
export const TINY_PNG = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0,
  0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 248, 255, 255, 63, 0, 5, 254, 2,
  254, 167, 53, 129, 132, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]);

/** A valid 38x38 PNG, the icon size. Per-pass overrides are size-checked. */
export const ICON_PNG = makePng(38, 38);

export interface FakeWorkflow {
  created: { id: string; params: unknown }[];
  create(options: { id: string; params: unknown }): Promise<{ id: string }>;
}

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
  workflow: FakeWorkflow;
  /** Awaits background work started with waitUntil (outbox dispatch). */
  settle(): Promise<void>;
  /** Registers a device for a pass the way Wallet would. */
  device(pass: Pass, deviceId: string, token: string): Promise<void>;
  /** Creates a pass through the real service. */
  pass(input?: { memberName?: string; holderEmail?: string; orgId?: string }): Promise<Pass>;
}

/** Real D1/R2 with fake queue, APNs, mailer and an in-memory template registry. */
export async function setupKit(): Promise<Kit> {
  const queue = createFakeQueue();
  const workflow: FakeWorkflow = {
    created: [],
    async create(options) {
      workflow.created.push(options);
      return { id: options.id };
    },
  };
  const env = await makeEnv({
    JOBS: queue as unknown as Queue,
    BULK_REISSUE: workflow as unknown as Workflow,
  });
  const clock = new ManualClock(Date.now());
  const fx = fixtures(env, clock);
  const { resolved, registry } = makeTemplate({ id: `tpl-${fx.ids.token(4)}` });
  const apns = createFakeApns();
  const mailer = createFakeMailer();
  // The real registries throw NotFoundError for an unknown template; the fake throws a plain Error.
  const resolveTemplate = registry.resolve.bind(registry);
  registry.resolve = async (id, version) => {
    let template: ResolvedTemplate;
    try {
      template = await resolveTemplate(id, version);
    } catch {
      throw new NotFoundError('Template not found.', 'TEMPLATE_NOT_FOUND');
    }
    // The fake stores crc32 0 for every asset, which would put bad CRCs into every kit pass.
    const assets = await Promise.all(
      template.assets.map(async (a) => {
        const bytes = new Uint8Array(
          await new Response(await registry.openAsset(template, a.name)).arrayBuffer(),
        );
        return { ...a, crc32: crc32(bytes) };
      }),
    );
    return { ...template, assets };
  };
  overrideDeps(env, { registry, apns, mailer });
  await ensurePlatformIdentity(env, clock.now());
  const org = await makeOrg(fx, { name: 'Test Gym' });
  await persistTemplate(fx, resolved);
  const background: Promise<unknown>[] = [];
  const ctx = {
    ...createServiceContext(env, { clock }),
    waitUntil: (promise: Promise<unknown>) => void background.push(promise),
  };
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
    workflow,
    async settle() {
      await Promise.all(background.splice(0));
    },
    async device(pass, deviceId, token) {
      await addRegistration(env.DB, {
        deviceId,
        identityId: pass.identityId,
        passId: pass.id,
        pushToken: token,
        now: clock.now(),
      });
    },
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

/** Walks the central directory and checks every stored CRC-32 against the data. Returns the names. */
export function expectValidZip(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = bytes.length - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd--;
  expect(eocd, 'end of central directory').toBeGreaterThanOrEqual(0);
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const packed = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + packed);
    const data = method === 0 ? raw : inflateSync(raw);
    expect(crc32(data) >>> 0, `CRC of ${name}`).toBe(crc);
    names.push(name);
    at += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}
