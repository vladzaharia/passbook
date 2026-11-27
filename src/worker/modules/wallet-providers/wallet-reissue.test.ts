import { afterEach, describe, expect, it, vi } from 'vitest';
import { countQueries } from '../../jobs/query-counter.ts';
import { first } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { toDto } from '../operations/dto.ts';
import { rowById } from '../operations/repo.ts';
import { fixture, mock, restore, tokenOf } from './google-runtime-test-fixtures.ts';
import { issueWalletOffer } from './offers.ts';
import { countReissueInstances } from './repo-wallet-reissue.ts';
import { drainWalletProviderSync } from './sync.ts';
import {
  handleWalletReissue,
  MAX_COPY_FAILURES,
  QUERIES_PER_COPY,
  startWalletReissue,
} from './wallet-reissue.ts';

const failing = vi.hoisted(() => ({ ids: new Set<string>() }));
vi.mock('./lifecycle.ts', async (original) => {
  const real = await original<typeof import('./lifecycle.ts')>();
  return {
    ...real,
    reconcileWalletInstance: (ctx: never, instance: { id: string }, ...rest: never[]) => {
      if (failing.ids.has(instance.id)) throw new Error('D1 query limit');
      return real.reconcileWalletInstance(ctx, instance as never, ...rest);
    },
  };
});

afterEach(() => {
  failing.ids.clear();
  for (const undo of restore.splice(0).reverse()) undo();
  vi.unstubAllGlobals();
});

const patches = (mark: number) =>
  mock.requests.slice(mark).filter((r) => r.method === 'PATCH' && r.path.includes('Object'));

async function tapped() {
  const { f } = await fixture();
  await issueWalletOffer(f.kit.ctx, await tokenOf(f), 'google');
  const ctx = jobCtxOf(f.kit);
  await drainWalletProviderSync(ctx);
  const scope = { orgId: f.kit.org.id, mode: 'live' as const, provider: 'google' as const };
  const job = (reissueId: string, after?: string) => ({
    kind: 'wallet.reissue' as const,
    reissueId,
    ...scope,
    ...(after ? { after } : {}),
  });
  return { f, ctx, scope, job };
}

describe('wallet reissue', () => {
  it('counts the copies it reaches: the active ones of this wallet and mode, of one template when named', async () => {
    const { f, scope } = await tapped();
    expect(await countReissueInstances(f.kit.env.DB, scope)).toBe(1);
    expect(
      await countReissueInstances(f.kit.env.DB, { ...scope, templateId: f.pass.templateId }),
    ).toBe(1);
    expect(
      await countReissueInstances(f.kit.env.DB, { ...scope, templateId: 'another-template' }),
    ).toBe(0);
    expect(await countReissueInstances(f.kit.env.DB, { ...scope, provider: 'samsung' })).toBe(0);
    expect(await countReissueInstances(f.kit.env.DB, { ...scope, mode: 'test' })).toBe(0);
  });

  it('sends the same pass again under a new operation, once per reissue however often the job runs', async () => {
    const { ctx, job } = await tapped();
    const mark = mock.requests.length;
    await drainWalletProviderSync(ctx);
    expect(patches(mark)).toHaveLength(0);

    await handleWalletReissue(job('reissue-1'), ctx);
    await drainWalletProviderSync(ctx);
    expect(patches(mark)).toHaveLength(1);

    // A redelivered job finds its operation and adds none.
    await handleWalletReissue(job('reissue-1'), ctx);
    await drainWalletProviderSync(ctx);
    expect(patches(mark)).toHaveLength(1);

    await handleWalletReissue(job('reissue-2'), ctx);
    await drainWalletProviderSync(ctx);
    expect(patches(mark)).toHaveLength(2);
  });

  it('leaves a voided pass to its revoke: a reissue never re-opens it', async () => {
    const { f, ctx, job } = await tapped();
    const { voidPass } = await import('../passes/service.ts');
    await voidPass(ctx, { type: 'system', id: null }, f.pass.id, {
      orgId: f.kit.org.id,
      mode: 'live',
      principal: 'session',
    });
    await drainWalletProviderSync(ctx);
    await handleWalletReissue(job('reissue-3'), ctx);
    await drainWalletProviderSync(ctx);
    const [object] = [...mock.google.genericObject.values()];
    expect(object).toMatchObject({ state: 'INACTIVE' });
  });
});

describe('a reissue run is sized by what a copy costs', () => {
  it('spends no more queries per copy than the batch is sized for', async () => {
    const { f, ctx, job } = await tapped();
    const counter = countQueries(f.kit.env);
    await handleWalletReissue(job('measured'), { ...ctx, env: counter.env });
    // One copy, with the run's own listing and keyset reads in the count: 31 when measured.
    expect(counter.count()).toBeLessThanOrEqual(QUERIES_PER_COPY);
  });
});

describe('a copy that fails mid-run', () => {
  async function failedRun() {
    const { f, ctx, job } = await tapped();
    const id =
      (await first<{ id: string }>(f.kit.env.DB, 'SELECT id FROM wallet_provider_instances'))?.id ??
      '';
    failing.ids.add(id);
    const send = vi.spyOn(ctx.env.JOBS, 'send').mockResolvedValue(undefined as never);
    return { ctx, job, id, send };
  }

  it('is resumed from itself, not skipped, and a redelivery does not fork the chain', async () => {
    const { ctx, job, id, send } = await failedRun();
    await handleWalletReissue(job('r-fail'), ctx);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({ after: '', failedId: id, failures: 1 });
    await handleWalletReissue(job('r-fail'), ctx);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('is skipped, with a logged code, only after its tries are spent; the rest go on', async () => {
    const { ctx, job, id, send } = await failedRun();
    const error = vi.spyOn(ctx.log, 'error');
    await handleWalletReissue(
      { ...job('r-skip'), failedId: id, failures: MAX_COPY_FAILURES - 1 },
      ctx,
    );
    expect(error).toHaveBeenCalledWith(
      'wallet.reissue_instance_skipped',
      expect.objectContaining({ code: 'WALLET_REISSUE_SKIPPED' }),
    );
    expect(send).not.toHaveBeenCalled();
  });
});

describe('wallet reissue as an operation', () => {
  it('counts the copies it reaches and ends Done', async () => {
    const { f, ctx, scope } = await tapped();
    const started = await startWalletReissue(ctx, scope, { actor: { type: 'user', id: 'u1' } });
    expect(started.operationId).not.toBeNull();
    const queued = f.kit.queue.sent.at(-1) as Parameters<typeof handleWalletReissue>[0];
    expect(queued).toMatchObject({
      reissueId: started.operationId,
      operationId: started.operationId,
      total: 1,
    });
    const op = async () => toDto((await rowById(f.kit.env.DB, started.operationId ?? '')) as never);
    expect((await op()).steps[0]).toMatchObject({ state: 'running', done: 0, total: 1 });
    await handleWalletReissue(queued, ctx);
    expect(await op()).toMatchObject({
      status: 'succeeded',
      kind: 'wallet.reissue',
      target: { type: 'wallet-provider', id: 'google' },
      result: { ids: { updated: '1', skipped: '0' } },
    });
  });

  it('a copy skipped after its tries is counted as skipped, and the run still ends', async () => {
    const { f, ctx, scope } = await tapped();
    const started = await startWalletReissue(ctx, scope, { actor: { type: 'user', id: 'u1' } });
    const first1 = f.kit.queue.sent.at(-1) as Parameters<typeof handleWalletReissue>[0];
    const instance = await first<{ id: string }>(
      f.kit.env.DB,
      'SELECT id FROM wallet_provider_instances WHERE org_id = ? LIMIT 1',
      [scope.orgId],
    );
    failing.ids.add(instance?.id ?? '');
    let job = first1;
    for (let i = 0; i < MAX_COPY_FAILURES; i++) {
      await handleWalletReissue(job, ctx);
      job = f.kit.queue.sent.at(-1) as typeof job;
    }
    const op = toDto((await rowById(f.kit.env.DB, started.operationId ?? '')) as never);
    expect(op).toMatchObject({ status: 'succeeded', result: { ids: { skipped: '1' } } });
  });
});
