// A pass with a live typed Google object on the mock wallet server, for the change-message send path.
import { vi } from 'vitest';
import { installKeysetTestEnv } from '../../../../test/helpers/credential-keyset.ts';
import { createMockWallets } from '../../../../test/mock-wallets/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { publishPass } from '../passes/publish.ts';
import { updatePass } from '../passes/service.ts';
import { clearSettingsCache } from '../settings/service.ts';
import { getVersion } from '../templates/repo.ts';
import { issueWalletOffer, listWalletOffers } from './offers.ts';
import { setupWalletOfferKit } from './offers-test-fixtures.ts';
import { computeProjectionPins } from './projection-pins.ts';
import {
  approveProjectionCandidate,
  createProjectionCandidate,
  publishProjectionRelease,
} from './projection-service.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';
import { drainWalletProviderSync } from './sync.ts';

export const messagesEnv = installKeysetTestEnv();

/** Google, as the mock: provider hosts map onto it, nothing else leaves the test. */
function routeFetchToMock(mock: ReturnType<typeof createMockWallets>): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const target =
      url.hostname === 'oauth2.googleapis.com'
        ? 'http://mock.test/token'
        : url.hostname === 'walletobjects.googleapis.com'
          ? `http://mock.test${url.pathname}`
          : null;
    if (!target) throw new Error(`Unexpected request to ${url.hostname}`);
    const { redirect: _r, signal: _s, ...rest } = init ?? {};
    return mock.handle(new Request(target, rest));
  });
}

/** The approved schema 2 Google release, a first tap, and helpers to edit and drain. */
export async function messageKit(restore: (() => void)[]) {
  let clockNow = () => Date.now();
  const mock = createMockWallets({ now: () => clockNow() });
  routeFetchToMock(mock);
  const f = await setupWalletOfferKit({
    google: 'configured',
    samsung: 'absent',
    db: (await messagesEnv()).DB,
  });
  clockNow = () => f.kit.clock.now();
  const { kit, apple } = f;
  const version = await getVersion(kit.env.DB, kit.template.id, kit.template.version);
  if (!version) throw new Error('Offer fixture version is missing.');
  const { pins } = await computeProjectionPins(kit.ctx, 'google', version);
  const scope = { orgId: kit.org.id, mode: 'live' as const, provider: 'google' as const };
  const candidate = await createProjectionCandidate(kit.ctx, apple.authorAuth, kit.template.id, {
    ...scope,
    version: kit.template.version,
    sourceReleaseId: apple.id,
    projection: { schema: 2, provider: 'google', approvedOmissions: pins.approvedOmissions },
  });
  const approval = await approveProjectionCandidate(
    kit.ctx,
    apple.reviewerAuth,
    kit.template.id,
    candidate.id,
    { ...scope, candidateHash: candidate.candidateHash },
  );
  await publishProjectionRelease(kit.ctx, apple.publisherAuth, kit.template.id, {
    ...scope,
    candidateId: candidate.id,
    approvalId: approval.id,
    candidateHash: candidate.candidateHash,
    expectedGeneration: 0,
  });
  restore.push(setWalletProvidersEnabledForTest(true));
  for (const name of [
    'wallet_provider_generation_insert_guard',
    'wallet_provider_generation_binding_guard',
    'wallet_provider_generation_offer_insert',
    'wallet_provider_generation_offer_consume',
  ])
    await run(kit.env.DB, `DROP TRIGGER IF EXISTS ${name}`);
  // Apple's own daily limit stays out of the way: only Google's is under test.
  await run(
    kit.env.DB,
    "INSERT INTO settings (scope, key, value, updated_at) VALUES ('platform', 'push.budgetPerDay', '50', ?)",
    [kit.clock.now()],
  );
  clearSettingsCache(kit.env.DB);
  const jobCtx = jobCtxOf(kit);
  const [offer] = await listWalletOffers(kit.ctx, f.pass.id);
  const token = offer?.href.split('/')[2] ?? '';
  await issueWalletOffer(kit.ctx, token, 'google');
  // The review read a sync run starts under waitUntil must finish before a test marks its call window.
  await kit.settle();
  const db = kit.env.DB;
  const drain = async () => {
    await drainWalletProviderSync(jobCtx);
    await kit.settle();
  };
  return {
    f,
    kit,
    mock,
    db,
    jobCtx,
    drain,
    token,
    /** Edits the member name and drains; `notify` keeps the changeMessage on the moved field. */
    async edit(name: string, notify = true) {
      await updatePass(
        jobCtx,
        { type: 'system', id: null },
        f.pass.id,
        { input: { memberName: name }, ...(notify ? { notify: true } : {}) },
        { scope: null },
      );
      await drain();
    },
    /** The same edit as a broadcast: `text` replaces the template's change message on the moved field. */
    async broadcast(name: string, text: string) {
      await publishPass(jobCtx, {
        passId: f.pass.id,
        orgScope: null,
        cause: 'admin',
        actor: { type: 'system', id: null },
        notify: true,
        changeText: text,
        mutate: (current) => ({
          personalization: { ...current.personalization, memberName: name },
        }),
      });
      await drain();
    },
    /** Provider calls since `mark`, as `METHOD collection` (and `/addMessage` for a message). */
    calls: (mark: number) =>
      mock.requests
        .slice(mark)
        .filter((r) => r.path.includes('walletobjects'))
        .map(
          (r) =>
            `${r.method} ${r.path.split('/')[3]}${r.path.endsWith('/addMessage') ? '/addMessage' : ''}`,
        ),
    /** The `messages` the last object PATCH since `mark` carried. */
    patchedMessages: (mark: number) => {
      const body = mock.requests
        .slice(mark)
        .filter((r) => r.method === 'PATCH')
        .at(-1)?.body as { messages?: { id: string; messageType: string }[] } | undefined;
      return body?.messages ?? [];
    },
    /** The messageType of every addMessage the mock saw, in order. */
    sent: () =>
      mock.requests
        .filter((r) => r.path.endsWith('/addMessage'))
        .map((r) => (r.body as { message: { messageType: string } }).message.messageType),
    object: () => [...mock.google.genericObject.values()][0],
    messages: () =>
      (mock.google.genericObject.values().next().value?.messages ?? []) as {
        id: string;
        body: string;
        header: string;
        messageType: string;
      }[],
    ledger: () =>
      all<{
        state: string;
        reason: string | null;
        base_version: number;
        target_version: number;
        tries: number;
      }>(
        db,
        'SELECT state, reason, base_version, target_version, tries FROM wallet_google_messages ORDER BY created_at, target_version',
      ),
    addMessageCalls: () =>
      mock.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/addMessage')),
    events: () =>
      all<{ data: string }>(
        db,
        "SELECT data FROM pass_events WHERE pass_id = ? AND kind = 'wallet.messaged' ORDER BY at, id",
        [f.pass.id],
      ),
    first,
  };
}
