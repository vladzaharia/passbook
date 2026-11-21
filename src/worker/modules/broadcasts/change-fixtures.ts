import { expect } from 'vitest';
import { BroadcastSchema } from '../../../shared/contracts/index.ts';
import { createApp } from '../../app.ts';
import { runBroadcast } from '../../workflows/broadcast.ts';
import { itemsWithBefore } from './repo-items.ts';
import { type BroadcastAuth, type BroadcastKit, broadcastAuth, broadcastKit } from './test-kit.ts';

export const ORIGIN = 'https://wallet.test';
type Headers = Record<string, string>;
type Step = Parameters<typeof runBroadcast>[3];
const stepRun = {
  do: async (_n: string, a: unknown, b?: unknown) =>
    await ((typeof a === 'function' ? a : b) as () => Promise<unknown>)(),
} as unknown as Step;

export interface ChangeKit {
  kit: BroadcastKit;
  auth: BroadcastAuth;
  app: ReturnType<typeof createApp>;
  api(path: string, init?: RequestInit & { headers?: Headers }): Promise<Response>;
  post(path: string, body?: unknown, headers?: Headers): Promise<Response>;
  /** Runs the newest workflow instance, inline. */
  runNext(): Promise<void>;
  /** Creates a change run and runs it. */
  change(
    body: Record<string, unknown>,
    headers?: Headers,
  ): Promise<ReturnType<typeof BroadcastSchema.parse>>;
  get(id: string): Promise<ReturnType<typeof BroadcastSchema.parse>>;
  items(id: string): Promise<
    {
      pass_id: string;
      outcome: string;
      before: string | null;
      version: number | null;
      silent: number;
    }[]
  >;
}

export async function changeKit(): Promise<ChangeKit> {
  const kit = await broadcastKit();
  const auth = await broadcastAuth(kit, ORIGIN);
  const app = createApp({ stores: auth.stores, clock: kit.clock });
  const api: ChangeKit['api'] = async (path, init = {}) =>
    app.request(`${ORIGIN}/api/v1${path}`, init, kit.env);
  const post: ChangeKit['post'] = (path, body = {}, headers = auth.admin()) =>
    api(path, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const runNext = async () => {
    const instance = kit.broadcast.created.at(-1);
    const params = instance?.params as { broadcastId: string } | undefined;
    if (!instance || !params) throw new Error('No workflow instance to run.');
    await runBroadcast(kit.env, instance.id, params, stepRun, undefined, kit.clock);
    await kit.settle();
  };
  const get = async (id: string) =>
    BroadcastSchema.parse(await (await api(`/broadcasts/${id}`, { headers: auth.admin() })).json());
  return {
    kit,
    auth,
    app,
    api,
    post,
    runNext,
    get,
    async change(body, headers = auth.admin()) {
      const before = kit.broadcast.created.length;
      const res = await post(
        '/broadcasts',
        { orgId: kit.org.id, kind: 'change', ...body },
        headers,
      );
      expect(res.status).toBe(201);
      const created = BroadcastSchema.parse(await res.json());
      if (kit.broadcast.created.length > before) await runNext();
      return get(created.id);
    },
    items: (id) => itemsWithBefore(kit.env.DB, id),
  };
}
