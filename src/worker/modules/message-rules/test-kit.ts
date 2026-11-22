import { persistTemplate } from '../../../../test/helpers/index.ts';
import type { PassJson, TemplateManifest } from '../../../passkit/types.ts';
import { createApp } from '../../app.ts';
import { runBroadcast } from '../../workflows/broadcast.ts';
import { startDueBroadcasts } from '../broadcasts/start.ts';
import {
  type BroadcastAuth,
  type BroadcastKit,
  broadcastAuth,
  broadcastKit,
} from '../broadcasts/test-kit.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { createPassRow } from '../passes/create.ts';
import { TINY_PNG } from '../passes/pass-test-fixtures.ts';
import type { Pass } from '../passes/repo.ts';

export const ORIGIN = 'https://wallet.test';

const manifest: TemplateManifest = {
  schema: 1,
  name: 'Dated template',
  inputs: {
    type: 'object',
    required: ['memberName'],
    properties: {
      memberName: { type: 'string', minLength: 1 },
      expiry: { type: 'string', format: 'date' },
      startsAt: { type: 'string', format: 'date-time' },
      birthday: { type: 'string', format: 'date' },
      message: { type: 'string', maxLength: 256 },
    },
  },
  sample: { memberName: 'Alex Morgan' },
  bindings: [
    { to: { field: 'name' }, value: '{{memberName}}' },
    { to: { field: 'message' }, value: '{{message}}' },
  ],
  display: { title: '{{memberName}}' },
  messaging: { input: 'message' },
};

const passJson = {
  formatVersion: 1,
  passTypeIdentifier: 'placeholder',
  teamIdentifier: 'placeholder',
  serialNumber: 'placeholder',
  organizationName: 'placeholder',
  description: 'Test pass',
  generic: {
    primaryFields: [{ key: 'name', label: 'Member', value: '' }],
    backFields: [{ key: 'message', label: 'Message', value: '', changeMessage: '%@' }],
  },
} as PassJson;

export interface RuleKit extends BroadcastKit {
  auth: BroadcastAuth;
  app: ReturnType<typeof createApp>;
  dated: { id: string };
  api(path: string, init?: RequestInit): Promise<Response>;
  /** POST/PUT/DELETE as the org admin. */
  send(method: string, path: string, body?: unknown): Promise<Response>;
  datedPass(input?: Record<string, string>, holderEmail?: string): Promise<Pass>;
  ruleBody(extra?: Record<string, unknown>): Record<string, unknown>;
  /** Starts every due broadcast and runs its workflow to the end. */
  runDue(): Promise<void>;
}

export async function ruleKit(): Promise<RuleKit> {
  const kit = await broadcastKit();
  const auth = await broadcastAuth(kit, ORIGIN);
  const app = createApp({ stores: auth.stores, clock: kit.clock });
  const resolved = kit.registry.add({
    id: `tpl-dated-${kit.fx.ids.token(4)}`,
    version: 'v1',
    manifest,
    passJson,
    assets: { 'icon.png': TINY_PNG },
  });
  await persistTemplate(kit.fx, resolved, { registry: kit.registry });
  const dated = { id: resolved.id };
  const api = async (path: string, init: RequestInit = {}) =>
    app.request(`${ORIGIN}/api/v1${path}`, init, kit.env);
  const stepRun = {
    do: async (_n: string, a: unknown, b?: unknown) =>
      await ((typeof a === 'function' ? a : b) as () => Promise<unknown>)(),
  } as unknown as Parameters<typeof runBroadcast>[3];
  const ran = new Set<string>();
  // Rules read a template through the mode's release, so the dated template has one in each mode.
  const release = await approveAppleRelease(kit, {
    templateId: dated.id,
    version: resolved.version,
    orgId: kit.org.id,
    mode: 'live',
  });
  await approveAppleRelease(kit, {
    templateId: dated.id,
    version: resolved.version,
    orgId: kit.org.id,
    mode: 'test',
  });
  return {
    ...kit,
    auth,
    app,
    dated,
    api,
    send: (method, path, body) =>
      api(path, {
        method,
        headers: { ...auth.admin(), 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    ruleBody: (extra = {}) => ({
      orgId: kit.org.id,
      name: 'Renewal',
      templateIds: [dated.id],
      anchor: { kind: 'input', input: 'expiry' },
      offset: { amount: 7, unit: 'day', when: 'before' },
      timeZone: 'UTC',
      message: 'Renew soon.',
      ...extra,
    }),
    datedPass: async (input = {}, holderEmail) => {
      return createPassRow(jobCtxOf(kit), {
        orgId: kit.org.id,
        templateId: dated.id,
        templateVersion: release.version,
        releaseId: release.id,
        releaseGeneration: release.generation,
        input: { memberName: 'Alex', ...input },
        holderEmail: holderEmail ?? null,
        source: 'manual',
        mode: 'live',
        execution: { kind: 'system' },
        actor: { type: 'system', id: null },
      });
    },
    runDue: async () => {
      await startDueBroadcasts(jobCtxOf(kit));
      for (const instance of kit.broadcast.created.filter((i) => !ran.has(i.id))) {
        ran.add(instance.id);
        await runBroadcast(
          kit.env,
          instance.id,
          instance.params as { broadcastId: string },
          stepRun,
          undefined,
          kit.clock,
        );
      }
      await kit.settle();
    },
  };
}
