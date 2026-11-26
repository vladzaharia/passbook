// Architecture 6.1, Google column: every row of the propagation table against the mock wallet server.
// Apple and Samsung rows are in lifecycle-parity.test.ts. Door denial commits before any provider call.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getHolderPass } from '../holders/repo.ts';
import { startCredentialTransfer } from '../passes/credential-transfer.ts';
import { removePass, restorePass } from '../passes/remove.ts';
import { deletePass, unvoidPass, updatePass, voidPass } from '../passes/service.ts';
import { getWalletProviderReadiness } from './account-service.ts';
import { fixture, mock, restore, tokenOf } from './google-runtime-test-fixtures.ts';
import { configureOn } from './legacy-on-test-fixtures.ts';
import { issueWalletOffer } from './offers.ts';
import { drainWalletProviderSync } from './sync.ts';

afterEach(() => {
  for (const undo of restore.splice(0).reverse()) undo();
  vi.unstubAllGlobals();
});

const system = { type: 'system', id: null } as const;
type Fixture = Awaited<ReturnType<typeof fixture>>['f'];

/** A pass whose first tap built its object. */
async function issued() {
  const { f } = await fixture();
  await issueWalletOffer(f.kit.ctx, await tokenOf(f), 'google');
  return { f, jobCtx: jobCtxOf(f.kit) };
}

/** An edit of the member name; the `Member` field notifies (as a template's `changeMessage` would) unless quiet. */
async function edit(f: Fixture, memberName: string, quiet = false) {
  await updatePass(jobCtxOf(f.kit), system, f.pass.id, { input: { memberName } }, { scope: null });
  if (!quiet)
    await run(
      f.kit.env.DB,
      `UPDATE pass_versions SET pass_json = replace(pass_json, '"label":"Member"', '"label":"Member","changeMessage":"Member is now %@"') WHERE pass_id = ?`,
      [f.pass.id],
    );
}

const live = (f: Fixture) => ({ orgId: f.kit.org.id, mode: 'live', principal: 'session' }) as const;

/** Provider requests after `mark`, as `METHOD collection[/action]`. */
const sent = (mark: number) =>
  mock.requests
    .slice(mark)
    .filter((r) => r.path.includes('walletobjects'))
    .map(
      (r) =>
        `${r.method} ${r.path.split('/')[3]}${r.path.endsWith('/addMessage') ? '/addMessage' : ''}`,
    );

const only = (collection: 'genericObject') => [...mock.google[collection].values()][0];

describe('6.1 Google: edit, connection sync, reissue', () => {
  it('PATCHes the object with no class and no message when nothing is marked to notify', async () => {
    const { f, jobCtx } = await issued();
    await run(
      f.kit.env.DB,
      `UPDATE pass_versions SET pass_json = replace(pass_json, ',"changeMessage":"Member is now %@"', '') WHERE pass_id = ?`,
      [f.pass.id],
    );
    const mark = mock.requests.length;
    await edit(f, 'Quiet Member', true);
    await drainWalletProviderSync(jobCtx);
    expect(sent(mark)).toEqual(['PATCH genericObject']);
    expect(await all(f.kit.env.DB, 'SELECT 1 FROM wallet_google_messages')).toEqual([]);
  });
});

describe('6.1 Google: void, unvoid, remove, delete', () => {
  /** The pass is denied at the door by the time Google is first called. */
  function recordDenialAtFanOut(f: Fixture, denied: string[]) {
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        const pass = await first<{ status: string; removed_at: number | null }>(
          f.kit.env.DB,
          'SELECT status, removed_at FROM passes WHERE id = ?',
          [f.pass.id],
        );
        denied.push(`${pass?.status}/${pass?.removed_at === null ? 'kept' : 'removed'}`);
      }
      return real(input, init);
    });
  }

  it('void: denied first, then PUT inactive without the barcode, one message and no addMessage', async () => {
    const { f, jobCtx } = await issued();
    const denied: string[] = [];
    recordDenialAtFanOut(f, denied);
    await voidPass(jobCtx, system, f.pass.id, live(f));
    await drainWalletProviderSync(jobCtx);
    expect(denied).toEqual(['voided/kept']);
    expect(only('genericObject')).toMatchObject({
      state: 'INACTIVE',
      messages: [{ body: 'This pass is no longer valid.' }],
    });
    expect(only('genericObject')).not.toHaveProperty('barcode');
    expect(mock.requests.filter((r) => r.path.endsWith('/addMessage'))).toEqual([]);
  });

  it('unvoid: PATCH active with its barcode back and the voided message gone', async () => {
    const { f, jobCtx } = await issued();
    await voidPass(jobCtx, system, f.pass.id, live(f));
    await drainWalletProviderSync(jobCtx);
    await unvoidPass(jobCtx, system, f.pass.id, live(f));
    await drainWalletProviderSync(jobCtx);
    expect(only('genericObject')).toMatchObject({ state: 'ACTIVE', messages: [] });
  });

  it('remove and restore: as void, then as unvoid', async () => {
    const { f, jobCtx } = await issued();
    const denied: string[] = [];
    recordDenialAtFanOut(f, denied);
    await removePass(jobCtx, system, f.pass.id, {}, null);
    await drainWalletProviderSync(jobCtx);
    expect(denied).toEqual(['voided/removed']);
    expect(only('genericObject')).toMatchObject({ state: 'INACTIVE' });
    await restorePass(jobCtx, system, f.pass.id, null);
    await drainWalletProviderSync(jobCtx);
    expect(only('genericObject')).toMatchObject({ state: 'ACTIVE' });
  });

  it('delete: Google cannot delete, so the object is inactive and the instance settles', async () => {
    const { f, jobCtx } = await issued();
    await deletePass(jobCtx, system, f.pass.id, null);
    await drainWalletProviderSync(jobCtx);
    await drainWalletProviderSync(jobCtx);
    expect(only('genericObject')).toMatchObject({ state: 'INACTIVE' });
    expect(mock.requests.filter((r) => r.method === 'DELETE')).toEqual([]);
  });

  it('transfer: the old holder copy goes inactive and the old generation retires', async () => {
    const { f, jobCtx } = await issued();
    const holder = await getHolderPass(f.kit.env.DB, f.pass.id, null);
    if (!holder) throw new Error('Missing holder snapshot');
    const transfer = await startCredentialTransfer(
      jobCtx,
      system,
      f.pass.id,
      { holderEmail: 'new-holder@example.test', ownerUserId: null },
      null,
      { kind: 'tenant-holder', expected: holder },
    );
    expect(transfer.state).toBe('pending');
    await drainWalletProviderSync(jobCtx);
    await drainWalletProviderSync(jobCtx);
    expect(only('genericObject')).toMatchObject({ state: 'INACTIVE' });
    const rows = await all<{ lifecycle: string; credential_generation: number }>(
      f.kit.env.DB,
      `SELECT lifecycle, credential_generation FROM wallet_provider_instances
       WHERE pass_id = ? AND provider = 'google' ORDER BY credential_generation`,
      [f.pass.id],
    );
    expect(rows[0]?.lifecycle).toMatch(/revok|retired/);
  });

  it('quarantine: as void', async () => {
    const { f, jobCtx } = await issued();
    await run(f.kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [
      f.pass.id,
    ]);
    await drainWalletProviderSync(jobCtx);
    expect(only('genericObject')).toMatchObject({ state: 'INACTIVE' });
  });
});

describe('6.1 Google: expiry and upcoming events', () => {
  it('parks the instance until the next boundary, then recompiles with no edit', async () => {
    const { f, jobCtx } = await issued();
    const soon = f.kit.clock.now() + 3_600_000;
    await run(
      f.kit.env.DB,
      `UPDATE pass_versions SET pass_json = json_set(pass_json, '$.expirationDate', ?) WHERE pass_id = ?`,
      [new Date(soon).toISOString(), f.pass.id],
    );
    await edit(f, 'Expiring Member');
    await run(
      f.kit.env.DB,
      `UPDATE pass_versions SET pass_json = json_set(pass_json, '$.expirationDate', ?) WHERE pass_id = ?`,
      [new Date(soon).toISOString(), f.pass.id],
    );
    await drainWalletProviderSync(jobCtx);
    const parked = await first<{ next_attempt_at: number }>(
      f.kit.env.DB,
      'SELECT next_attempt_at FROM wallet_provider_instance_dirty',
    );
    expect(parked?.next_attempt_at).toBe(soon);
    const mark = mock.requests.length;
    await drainWalletProviderSync(jobCtx);
    expect(sent(mark)).toEqual([]);
    f.kit.clock.advance(3_600_001);
    await drainWalletProviderSync(jobCtx);
    await drainWalletProviderSync(jobCtx);
    expect(sent(mark)).toContain('PATCH genericObject');
    expect(await first(f.kit.env.DB, 'SELECT 1 FROM wallet_provider_instance_dirty')).toBeNull();
  });
});

describe('Q4: provider objects are created at the first tap, not at issue', () => {
  it('sends nothing to Google until the holder taps, then builds the object', async () => {
    const { f } = await fixture();
    await drainWalletProviderSync(jobCtxOf(f.kit));
    expect(mock.requests.filter((r) => r.path.includes('walletobjects'))).toEqual([]);
    expect(mock.google.genericObject.size).toBe(0);
    await issueWalletOffer(f.kit.ctx, await tokenOf(f), 'google');
    expect(mock.google.genericObject.size).toBe(1);
  });
});

describe('6.1 Google: keyset rotation and event roll-over', () => {
  it('a same-identity account rotation does not stop a void', async () => {
    const { f, jobCtx } = await issued();
    const readiness = await getWalletProviderReadiness(f.kit.ctx, {
      orgId: f.kit.org.id,
      mode: 'live',
      provider: 'google',
    });
    await configureOn(f.kit.ctx, f.auth, {
      orgId: f.kit.org.id,
      mode: 'live',
      provider: 'google',
      expectedRevision: readiness.revision,
      credentials: f.google,
    });
    // The door denial and the inactive object do not wait for a new release: a revoke needs only the identity.
    await voidPass(jobCtx, system, f.pass.id, live(f));
    await drainWalletProviderSync(jobCtx);
    expect(only('genericObject')).toMatchObject({ state: 'INACTIVE' });
  });

  it('a KEK ring rotation (a new current key, the old one kept) does not stop a void', async () => {
    const { f, jobCtx } = await issued();
    const env = f.kit.env as unknown as Record<string, unknown>;
    env.KEK_V2 = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
    try {
      const readiness = await getWalletProviderReadiness(f.kit.ctx, {
        orgId: f.kit.org.id,
        mode: 'live',
        provider: 'google',
      });
      // The new version is sealed under the new current key; the retained sealed copy still opens.
      await configureOn(f.kit.ctx, f.auth, {
        orgId: f.kit.org.id,
        mode: 'live',
        provider: 'google',
        expectedRevision: readiness.revision,
        credentials: f.google,
      });
      await voidPass(jobCtx, system, f.pass.id, live(f));
      await drainWalletProviderSync(jobCtx);
      expect(only('genericObject')).toMatchObject({ state: 'INACTIVE' });
    } finally {
      delete env.KEK_V2;
    }
  });

  it('parks the instance until the next upcoming event date, then recompiles', async () => {
    const { f, jobCtx } = await issued();
    const first_ = f.kit.clock.now() + 2 * 3_600_000;
    const second = f.kit.clock.now() + 5 * 3_600_000;
    const events = [first_, second].map((at) => ({
      dateInformation: { date: new Date(at).toISOString() },
    }));
    const patch = () =>
      run(
        f.kit.env.DB,
        `UPDATE pass_versions SET pass_json = json_set(pass_json, '$.upcomingPassInformation', json(?)) WHERE pass_id = ?`,
        [JSON.stringify(events), f.pass.id],
      );
    await edit(f, 'Event Member', true);
    await patch();
    await drainWalletProviderSync(jobCtx);
    const parked = () =>
      first<{ next_attempt_at: number }>(
        f.kit.env.DB,
        'SELECT next_attempt_at FROM wallet_provider_instance_dirty',
      );
    expect((await parked())?.next_attempt_at).toBe(first_);
    const mark = mock.requests.length;
    f.kit.clock.advance(2 * 3_600_000 + 1);
    await drainWalletProviderSync(jobCtx);
    await drainWalletProviderSync(jobCtx);
    expect(sent(mark)).toContain('PATCH genericObject');
    // The next boundary is the second event.
    expect((await parked())?.next_attempt_at).toBe(second);
  });
});
