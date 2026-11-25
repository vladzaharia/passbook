import { fakeAuth } from '../../../../test/helpers/fake-auth.ts';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { createScannerStore } from './auth-store.ts';
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

export const state = { money: '', app: undefined as unknown as ReturnType<typeof createApp> };
export const call = (
  method: string,
  headers: Record<string, string>,
  path: string,
  body?: unknown,
) =>
  Promise.resolve(
    state.app.request(
      `${ORIGIN}/api/v1/scan${path}`,
      {
        method,
        headers: { ...headers, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      kit.env,
    ),
  );
export async function setupDraftFixture() {
  // The hub's alarm runs on the runtime's clock: keep the test clock beside it.
  kit.clock.set(Date.now());
  const fake = fakeAuth(ORIGIN);
  fake.bindSessions(kit.env.DB, kit.clock);
  state.app = createApp({
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
  state.money = id;
}

const waits: Promise<unknown>[] = [];
export const ec = {
  waitUntil: (p: Promise<unknown>) => void waits.push(p),
  passThroughOnException() {},
};
export const flush = async () => {
  await Promise.all(waits.splice(0));
};

export async function desk(balance = 42.5) {
  const source = await kit.scanner({
    templateIds: [state.money],
    settings: { roleWithoutSignIn: 'desk' },
  });
  const customer = await screen('customer', [source.id], false, {}, { templateIds: [state.money] });
  const monitor = await screen('monitor', [source.id], false, {}, { templateIds: [state.money] });
  const pass = await kit.scanPass(state.money, { balance, visits: 3 });
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
export const drafts = (m: { messages: Record<string, unknown>[] }) =>
  m.messages.filter((x) => 'draft' in x);
export const wait = () => new Promise((resolve) => setTimeout(resolve, 80));
