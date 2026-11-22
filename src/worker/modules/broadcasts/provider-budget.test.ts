import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { createApp as CreateApp } from '../../app.ts';
import { all, run } from '../../platform/db.ts';
import type { runBroadcast as RunBroadcast } from '../../workflows/broadcast.ts';
import type { getPass as GetPass } from '../passes/repo-read-pass.ts';
import type {
  budgetOutcomes as BudgetOutcomes,
  providerBudgets as ProviderBudgets,
} from '../wallet-providers/notify-budget.ts';
import type { BroadcastAuth, BroadcastKit, broadcastKit as MakeKit } from './test-kit.ts';

// Google and Samsung copies are stubbed as live; the provider runtime itself is tested elsewhere.
vi.mock('../wallet-providers/instance.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getWalletInstance: vi.fn(async () => ({ lifecycle: 'active' })),
}));

vi.mock('../wallet-providers/provider-policy.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  walletProviderDisabledReason: vi.fn(async () => null),
}));
// Both wallets are on for the org; enrolment itself is tested with the channel gate.
vi.mock('../channels/gate.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  channelOn: vi.fn(async () => true),
}));

const ORIGIN = 'https://wallet.test';
let kit: BroadcastKit;
let auth: BroadcastAuth;
let app: ReturnType<typeof CreateApp>;
let runBroadcast: typeof RunBroadcast;
let providerBudgets: typeof ProviderBudgets;
let budgetOutcomes: typeof BudgetOutcomes;
let getPass: typeof GetPass;
let restore: () => void;

beforeAll(async () => {
  vi.resetModules();
  const { broadcastKit }: { broadcastKit: typeof MakeKit } = await import('./test-kit.ts');
  const { broadcastAuth } = await import('./test-kit.ts');
  const { createApp }: { createApp: typeof CreateApp } = await import('../../app.ts');
  ({ runBroadcast } = await import('../../workflows/broadcast.ts'));
  ({ providerBudgets, budgetOutcomes } = await import('../wallet-providers/notify-budget.ts'));
  ({ getPass } = await import('../passes/repo-read-pass.ts'));
  const { clearSettingsCache } = await import('../settings/service.ts');
  restore = (
    await import('../wallet-providers/provider-policy.ts')
  ).setWalletProvidersEnabledForTest(true);
  kit = await broadcastKit();
  // Apple's own limit stays out of the way: only the other wallets' limits are under test.
  await run(
    kit.env.DB,
    "INSERT INTO settings (scope, key, value, updated_at) VALUES ('platform', 'push.budgetPerDay', '10', ?)",
    [kit.clock.now()],
  );
  clearSettingsCache(kit.env.DB);
  auth = await broadcastAuth(kit, ORIGIN);
  app = createApp({ stores: auth.stores, clock: kit.clock });
});

afterAll(() => restore());

const stepRun = {
  do: async (_n: string, a: unknown, b?: unknown) =>
    await ((typeof a === 'function' ? a : b) as () => Promise<unknown>)(),
} as unknown as Parameters<typeof RunBroadcast>[3];

async function send(text: string) {
  const before = kit.broadcast.created.length;
  const res = await app.request(
    `${ORIGIN}/api/v1/broadcasts`,
    {
      method: 'POST',
      headers: { ...auth.admin(), 'content-type': 'application/json' },
      body: JSON.stringify({
        orgId: kit.org.id,
        kind: 'message',
        target: { templateIds: [kit.messaging.id] },
        patch: { message: text },
      }),
    },
    kit.env,
  );
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };
  await runBroadcast(
    kit.env,
    kit.broadcast.created.at(before)?.id ?? '',
    { broadcastId: id },
    stepRun,
    undefined,
    kit.clock,
  );
  await kit.settle();
}

const applied = async (passId: string) =>
  (
    await all<{ data: string }>(
      kit.env.DB,
      "SELECT data FROM pass_events WHERE pass_id = ? AND kind = 'message.applied' ORDER BY at, id",
      [passId],
    )
  ).map((r) => JSON.parse(r.data) as { providers?: Record<string, string> });

describe('broadcast budget per wallet', () => {
  it('reads only the Google gate and instance', async () => {
    const instance = await import('../wallet-providers/instance.ts');
    const policy = await import('../wallet-providers/provider-policy.ts');
    const pass = await kit.makePass();
    vi.mocked(instance.getWalletInstance).mockClear();
    vi.mocked(policy.walletProviderDisabledReason).mockClear();
    await providerBudgets(kit.ctx, (await getPass(kit.env.DB, pass.id)) ?? pass);
    const providers = [
      ...vi.mocked(instance.getWalletInstance).mock.calls.map((c) => c[1].provider),
      ...vi.mocked(policy.walletProviderDisabledReason).mock.calls.map((c) => c[1]),
    ];
    expect(providers.length).toBeGreaterThan(0);
    expect(providers.every((p) => p === 'google')).toBe(true);
  });

  it('defers instead of sending, counts nothing, and would skip over a full budget', async () => {
    const pass = await kit.makePass();
    const budgets = async () =>
      providerBudgets(kit.ctx, (await getPass(kit.env.DB, pass.id)) ?? pass);
    expect(await budgets()).toEqual({
      google: { used: 0, limit: 3, resetsAt: null },
    });
    for (const text of ['One', 'Two', 'Three', 'Four']) {
      await send(text);
      kit.clock.advance(1000);
    }
    // No provider message exists yet: every message is deferred and nothing is counted.
    const events = await applied(pass.id);
    expect(events.map((e) => e.providers?.google)).toEqual([
      'deferred',
      'deferred',
      'deferred',
      'deferred',
    ]);
    expect(events.every((e) => !('samsung' in (e.providers ?? {})))).toBe(true);
    expect((await budgets()).google).toMatchObject({ used: 0, limit: 3 });
    // The gate a real send calls: three sent messages in the window fill Google's budget.
    for (let i = 0; i < 3; i++)
      await run(
        kit.env.DB,
        "INSERT INTO pass_events (id, org_id, pass_id, mode, kind, actor_type, data, at) VALUES (?, ?, ?, 'live', 'message.applied', 'system', ?, ?)",
        [
          `sent-${i}`,
          kit.org.id,
          pass.id,
          JSON.stringify({ providers: { google: 'sent' } }),
          kit.clock.now(),
        ],
      );
    const full = await budgets();
    expect(full.google).toMatchObject({ used: 3, limit: 3 });
    expect(budgetOutcomes(full)).toEqual({ google: 'over' });
    kit.clock.advance(25 * 3_600_000);
    expect(budgetOutcomes(await budgets())).toMatchObject({ google: 'deferred' });
  });
});
