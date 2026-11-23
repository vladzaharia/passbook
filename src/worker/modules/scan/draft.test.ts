import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeAuth } from '../../../../test/helpers/fake-auth.ts';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { first, run } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { createScannerStore } from './auth-store.ts';
import { liveReadyId } from './live.ts';
import { sealLiveAttachment } from './live-attachment.ts';
import { hub, kit, screen } from './scan-hub-test-fixtures.ts';
import { codeOf, key, ORIGIN } from './test-kit.ts';

const ACTIONS = [
  {
    id: 'pay',
    label: 'Pay',
    kind: 'take',
    input: 'balance',
    amount: { max: 50 },
    repeat: 'always',
  },
  {
    id: 'top',
    label: 'Top up',
    kind: 'add',
    input: 'balance',
    amount: { max: 100 },
    repeat: 'always',
  },
  { id: 'stamp', label: 'Stamp', kind: 'add', input: 'visits', amount: 1, repeat: 'always' },
  { id: 'fix', label: 'Fix', kind: 'set', input: 'balance', repeat: 'always' },
  { id: 'in', label: 'Check in', kind: 'check_in' },
] as const;

let money: string;
let app: ReturnType<typeof createApp>;
const call = (method: string, headers: Record<string, string>, path: string, body?: unknown) =>
  Promise.resolve(
    app.request(
      `${ORIGIN}/api/v1/scan${path}`,
      {
        method,
        headers: { ...headers, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      kit.env,
    ),
  );
beforeAll(async () => {
  // The hub's alarm runs on the runtime's clock: keep the test clock beside it.
  kit.clock.set(Date.now());
  const fake = fakeAuth(ORIGIN);
  fake.bindSessions(kit.env.DB, kit.clock);
  app = createApp({
    stores: { ...fake.stores, scanners: createScannerStore(kit.env, kit.clock) },
    clock: kit.clock,
  });
  const id = await kit.scanTemplate('Prepaid', { actions: ACTIONS as never });
  const pinned = await kit.registry.resolve(id);
  const manifest = structuredClone(pinned.manifest);
  const props = manifest.inputs.properties as Record<string, Record<string, unknown>>;
  props.balance = { type: 'number', minimum: 0, 'x-format': 'currency', 'x-currency': 'USD' };
  props.visits = { type: 'integer', minimum: 0 };
  const revised = kit.registry.add({
    id,
    orgId: pinned.orgId,
    version: 'v2',
    manifest,
    passJson: pinned.passJson,
    assets: { 'icon.png': ICON_PNG },
  });
  await persistTemplate(kit.fx, revised, { registry: kit.registry, buildKey: 'draft-test' });
  for (const mode of ['live', 'test'] as const)
    await approveAppleRelease(kit, { templateId: id, version: 'v2', mode });
  money = id;
});

const waits: Promise<unknown>[] = [];
const ec = { waitUntil: (p: Promise<unknown>) => void waits.push(p), passThroughOnException() {} };
const flush = async () => {
  await Promise.all(waits.splice(0));
};

async function desk(balance = 42.5) {
  const source = await kit.scanner({
    templateIds: [money],
    settings: { roleWithoutSignIn: 'desk' },
  });
  const customer = await screen('customer', [source.id], false, {}, { templateIds: [money] });
  const monitor = await screen('monitor', [source.id], false, {}, { templateIds: [money] });
  const pass = await kit.scanPass(money, { balance, visits: 3 });
  const socketOf = async (s: { attachment: Parameters<typeof sealLiveAttachment>[1] }) => {
    const res = await hub().fetch(
      new Request('https://hub.test', {
        headers: {
          upgrade: 'websocket',
          'x-pb-live': await sealLiveAttachment(kit.env, s.attachment),
        },
      }),
    );
    const socket = res.webSocket;
    if (res.status !== 101 || !socket) throw new Error('The screen did not connect.');
    const messages: Record<string, unknown>[] = [];
    socket.addEventListener('message', (e) => messages.push(JSON.parse(String(e.data))));
    socket.accept();
    return { messages, close: () => socket.close(1000) };
  };
  const seen = await socketOf(customer);
  const watched = await socketOf(monitor);
  const read = async (
    id: string = source.id,
    input: unknown = codeOf(pass),
    h = source.headers,
  ) => {
    const ref = key();
    const res = await kit.post(
      h,
      '/resolve',
      { idempotencyKey: ref, input, clientTs: kit.clock.now() },
      ec as never,
    );
    await flush();
    return { ref, res, id };
  };
  const draft = (ref: string, actionId: string, amount: number, h = source.headers) =>
    call('PUT', h, '/draft', { ref, actionId, amount });
  const act = (actionId: string, amount?: number) =>
    kit.post(
      source.headers,
      '/actions',
      {
        idempotencyKey: key(),
        input: codeOf(pass),
        clientTs: kit.clock.now(),
        actionId,
        ...(amount === undefined ? {} : { amount }),
      },
      ec as never,
    );
  return {
    source,
    customer,
    pass,
    seen,
    watched,
    watchedHeaders: monitor.headers,
    read,
    draft,
    act,
    close: () => {
      seen.close();
      watched.close();
    },
  };
}
const drafts = (m: { messages: Record<string, unknown>[] }) =>
  m.messages.filter((x) => 'draft' in x);
const wait = () => new Promise((resolve) => setTimeout(resolve, 80));

describe('PUT /draft', () => {
  it('shows to pay and the balance after on the followed screen, never the monitor', async () => {
    const d = await desk();
    const { ref } = await d.read();
    const res = await d.draft(ref, 'pay', 12);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ screens: 1 });
    await wait();
    expect(drafts(d.seen)).toHaveLength(1);
    expect(drafts(d.seen)[0]).toMatchObject({
      draft: {
        customer: {
          screen: 'review',
          band: { headline: 'To pay $12.00', sub: 'Balance after: $30.50' },
        },
      },
    });
    expect(drafts(d.watched)).toEqual([]);
    const top = await d.draft(ref, 'top', 20);
    expect(await top.json()).toEqual({ screens: 1 });
    await wait();
    expect(drafts(d.seen).at(-1)).toMatchObject({
      draft: { customer: { band: { headline: 'Adding $20.00', sub: 'Balance after: $62.50' } } },
    });
    d.close();
  });

  it('shows only the figure when the balance is short', async () => {
    const d = await desk(10);
    const { ref } = await d.read();
    expect(await (await d.draft(ref, 'pay', 12)).json()).toEqual({ screens: 1 });
    await wait();
    expect(drafts(d.seen)[0]).toMatchObject({
      draft: { customer: { band: { headline: 'To pay $12.00', sub: null } } },
    });
    d.close();
  });

  it('refuses what is not money to take or add, or an amount past the limit', async () => {
    const d = await desk();
    const { ref } = await d.read();
    for (const [action, amount] of [
      ['stamp', 1],
      ['fix', 5],
      ['in', 1],
      ['nope', 1],
      ['pay', 0],
      ['pay', 51],
      ['pay', 1.234],
    ] as const) {
      const res = await d.draft(ref, action, amount);
      expect(res.status, `${action} ${amount}`).toBe(422);
      expect(await res.json()).toMatchObject({ code: 'SCAN_DRAFT_INVALID' });
    }
    await wait();
    expect(drafts(d.seen)).toEqual([]);
    d.close();
  });

  it('is stale for a read that is over, one from another scanner, or one not presented', async () => {
    const d = await desk();
    const old = await d.read();
    kit.clock.advance(61_000);
    const res = await d.draft(old.ref, 'pay', 5);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'SCAN_DRAFT_STALE' });
    const fresh = await d.read();
    const other = await kit.scanner({
      templateIds: [money],
      settings: { roleWithoutSignIn: 'desk' },
    });
    expect((await d.draft(fresh.ref, 'pay', 5, other.headers)).status).toBe(409);
    const manual = await d.read(d.source.id, { passId: d.pass.id, method: 'manual' });
    expect((await d.draft(manual.ref, 'pay', 5)).status).toBe(409);
    expect(drafts(d.seen)).toEqual([]);
    d.close();
  });

  it('is stale once the pass is no longer current', async () => {
    const d = await desk();
    const { ref } = await d.read();
    await run(
      kit.env.DB,
      "UPDATE passes SET status='voided', lifecycle_generation=lifecycle_generation+1 WHERE id=?",
      [d.pass.id],
    );
    expect((await d.draft(ref, 'pay', 5)).status).toBe(409);
    expect(drafts(d.seen)).toEqual([]);
    d.close();
  });

  it('refuses a screen: only a paired scanner drafts', async () => {
    const d = await desk();
    const { ref } = await d.read();
    expect((await d.draft(ref, 'pay', 5, d.customer.headers)).status).toBe(403);
    expect((await d.draft(ref, 'pay', 5, d.watchedHeaders)).status).toBe(403);
    d.close();
  });

  it('never blocks the commit when the hub fails', async () => {
    const d = await desk();
    const { ref } = await d.read();
    const real = kit.env.SCAN_HUB.getByName.bind(kit.env.SCAN_HUB);
    const spy = vi.spyOn(kit.env.SCAN_HUB, 'getByName').mockImplementation((name: string) => {
      const stub = real(name);
      return {
        ringRow: (id: string, now?: number) => stub.ringRow(id, now),
        publish: (input: Parameters<typeof stub.publish>[0]) => stub.publish(input),
        draft: () => Promise.reject(new Error('hub down')),
        clearDraft: () => Promise.reject(new Error('hub down')),
      } as never;
    });
    try {
      const res = await d.draft(ref, 'pay', 12);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ screens: 0 });
      const committed = await d.act('pay', 12);
      expect(committed.status).toBe(200);
      expect(await committed.json()).toMatchObject({
        kind: 'ok',
        value: { before: 42.5, after: 30.5 },
      });
    } finally {
      spy.mockRestore();
    }
    d.close();
  });
});

describe('DELETE /draft', () => {
  it('clears the draft and the ready card on the followed screen only', async () => {
    const d = await desk();
    const { ref } = await d.read();
    const readyId = await liveReadyId(d.source.id, ref);
    await d.draft(ref, 'pay', 12);
    const res = await call('DELETE', d.source.headers, `/draft?ref=${ref}`);
    expect(await res.json()).toEqual({ screens: 1 });
    await wait();
    expect(drafts(d.seen).at(-1)).toEqual({
      draft: { ref: readyId, at: expect.any(Number), cancelled: true },
    });
    expect(drafts(d.watched)).toEqual([]);
    const other = await kit.scanner({
      templateIds: [money],
      settings: { roleWithoutSignIn: 'desk' },
    });
    expect(await (await call('DELETE', other.headers, `/draft?ref=${ref}`)).json()).toEqual({
      screens: 0,
    });
    d.close();
  });
});

describe('the receipt on a committed scan', () => {
  it('says what was paid and the balance after, and what was added', async () => {
    const d = await desk();
    expect((await d.act('pay', 12)).status).toBe(200);
    await flush();
    await wait();
    expect(JSON.stringify(d.seen.messages)).toContain('Paid $12.00');
    expect(JSON.stringify(d.seen.messages)).toContain('Balance $30.50');
    expect((await d.act('top', 20)).status).toBe(200);
    await flush();
    await wait();
    expect(JSON.stringify(d.seen.messages)).toContain('Added $20.00');
    expect(JSON.stringify(d.seen.messages)).toContain('Balance $50.50');
    const bands = d.seen.messages.flatMap((m) =>
      ((m.rows as { customer?: { band: { headline: string } } }[]) ?? []).map(
        (r) => r.customer?.band.headline,
      ),
    );
    expect(bands).toEqual(['Paid $12.00', 'Added $20.00']);
    expect(await first(kit.env.DB, 'SELECT 1 FROM passes WHERE id=?', [d.pass.id])).not.toBeNull();
    d.close();
  });

  it('says plus the stamps and how many of the goal for a count', async () => {
    const d = await desk();
    expect((await d.act('stamp')).status).toBe(200);
    await flush();
    await wait();
    expect(JSON.stringify(d.seen.messages)).toContain('+1 visits');
    d.close();
  });
});
