import { vi } from 'vitest';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import type { OperationDto } from '../../../shared/contracts/operations.ts';
import { createApp } from '../../app.ts';
import { runJob } from '../../jobs/registry.ts';
import type { Job } from '../../jobs/types.ts';
import { fakeLimiter } from '../auth/test-support.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { setupTenantTestAuth } from '../passes/tenant-test-fixtures.ts';
import { ORIGIN, setupScanKit } from '../scan/test-kit.ts';

/** A holder signs in by email link, so every session here is `magic_link`: own-only. */
export async function setup() {
  const kit = await setupScanKit();
  const queued: Job[] = [];
  kit.env.JOBS = {
    send: vi.fn(async (job: Job) => void queued.push(job)),
    sendBatch: vi.fn(),
  } as unknown as Queue;
  kit.env.RL_REFRESH = fakeLimiter(1000) as unknown as RateLimit;
  const auth = await setupTenantTestAuth(kit);
  const templateId = await kit.scanTemplate('Holder ops', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
  const user = await makeUser(kit.fx);
  const stranger = await makeUser(kit.fx);
  const pass = await kit.scanPass(templateId, {}, { holderEmail: user.primaryEmail });
  const theirs = await kit.scanPass(templateId, {}, { holderEmail: stranger.primaryEmail });
  const session = (userId: string) => makeSession(kit.fx, { userId, amr: 'magic_link' });
  const mine = await session(user.id);
  const app = createApp({ clock: kit.clock, stores: auth.stores });
  const send = (method: string, path: string, headers: Record<string, string>) =>
    Promise.resolve(app.request(`${ORIGIN}${path}`, { method, headers }, kit.env));
  const post = (path: string, headers = mine.headers) => send('POST', `/api/v1/me${path}`, headers);
  const read = async (id: string, headers = mine.headers) =>
    send('GET', `/api/v1/operations/${id}`, headers);
  const operation = async (id: string, headers = mine.headers) =>
    (await (await read(id, headers)).json()) as OperationDto;
  const drain = async () => {
    for (const job of queued.splice(0)) await runJob(job, jobCtxOf(kit));
  };
  return {
    kit,
    auth,
    queued,
    user,
    stranger,
    pass,
    theirs,
    mine,
    session,
    post,
    read,
    operation,
    send,
    drain,
  };
}
