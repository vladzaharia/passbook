import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { first, run as sql } from '../../platform/db.ts';
import { listOrgCredentials } from './credential-service.ts';
import { readGoogleSecret } from './credential-system-save.ts';
import { setManagedDeps } from './google-managed-deps.ts';
import { type ManagedKit, managedKit } from './google-managed-kit-fixtures.ts';
import { requestManagedIssuer } from './google-managed-service.ts';
import {
  completeManualIssuer,
  latestManagedRun,
  runManagedIssuer,
  startManagedIssuer,
} from './issuer-provision.ts';
import { activeOrgGoogle } from './repo-google-managed.ts';

let m: ManagedKit;
beforeAll(async () => {
  m = await managedKit();
}, 30_000);
afterAll(() => setManagedDeps());

const run = (id: string) =>
  first<{
    state: string;
    waiting_for: string | null;
    error_code: string | null;
    step: string | null;
  }>(m.k.env.DB, 'SELECT state, waiting_for, error_code, step FROM identity_runs WHERE id = ?', [
    id,
  ]);
const posts = () =>
  m.stub.calls.filter((c) => c === 'POST walletobjects.googleapis.com/walletobjects/v1/issuer');

describe('managed Google issuer', () => {
  it('inserts "<Org> via PassBook" and records the issuer on the org', async () => {
    const org = await m.org('Acme Tickets');
    const started = await startManagedIssuer(m.ctx, { orgId: org.id, createdBy: null });
    expect(started.created).toBe(true);
    expect(m.sent).toContainEqual({ kind: 'wallet.google_issuer', runId: started.run.runId });
    await runManagedIssuer(m.ctx, started.run.runId);

    expect([...m.stub.issuers.values()]).toContain('Acme Tickets via PassBook');
    expect(await run(started.run.runId)).toMatchObject({ state: 'succeeded', error_code: null });
    const cred = await activeOrgGoogle(m.k.env.DB, org.id, 'live');
    expect(cred).toMatchObject({ provenance: 'managed', signer_ref: m.platform.id });
    const secret = await readGoogleSecret(m.ctx, cred?.id ?? '');
    expect(secret.credentials.issuerId).not.toBe('1000000000000001');
    expect(secret.credentials.privateKeyPem).toBe(
      (await readGoogleSecret(m.ctx, m.platform.id)).credentials.privateKeyPem,
    );
    // A rerun of a finished run changes nothing.
    const before = posts().length;
    await runManagedIssuer(m.ctx, started.run.runId);
    expect(posts()).toHaveLength(before);
  });

  it('adopts an issuer its claim says PassBook made for this org, instead of inserting again', async () => {
    const org = await m.org('Adopt Co');
    m.stub.issuers.set('5550001', 'Adopt Co via PassBook');
    await sql(
      m.k.env.DB,
      "INSERT INTO wallet_google_issuers (issuer_id, org_id, origin, claimed_at) VALUES ('5550001', ?, 'created', 1)",
      [org.id],
    );
    const { run: started } = await startManagedIssuer(m.ctx, { orgId: org.id, createdBy: null });
    const before = posts().length;
    await runManagedIssuer(m.ctx, started.runId);
    expect(posts()).toHaveLength(before);
    expect((await run(started.runId))?.state).toBe('succeeded');
    expect((await latestManagedRun(m.ctx, org.id))?.issuerId).toBe('5550001');
    expect((await activeOrgGoogle(m.k.env.DB, org.id, 'live'))?.identity_hint).toBe('0001');
  });

  it('records the claim as soon as Google answers; never adopts by name, even after a rename', async () => {
    const a = await m.org('Claimed Name');
    const ra = await startManagedIssuer(m.ctx, { orgId: a.id, createdBy: null });
    await runManagedIssuer(m.ctx, ra.run.runId);
    const issuerA = (await latestManagedRun(m.ctx, a.id))?.issuerId ?? '';
    expect(
      await first<{ org_id: string; origin: string }>(
        m.k.env.DB,
        'SELECT org_id, origin FROM wallet_google_issuers WHERE issuer_id = ?',
        [issuerA],
      ),
    ).toEqual({ org_id: a.id, origin: 'created' });
    // B takes A's name while A's issuer sits unheld in Google: B gets a new issuer of its own.
    const b = await m.org('Claimed Name');
    await sql(m.k.env.DB, 'UPDATE orgs SET name = ? WHERE id = ?', ['Claimed Name', b.id]);
    const before = posts().length;
    const rb = await startManagedIssuer(m.ctx, { orgId: b.id, createdBy: null });
    await runManagedIssuer(m.ctx, rb.run.runId);
    expect(posts()).toHaveLength(before + 1);
    expect((await latestManagedRun(m.ctx, b.id))?.issuerId).not.toBe(issuerA);
  });

  it('one delivery at a time: two jobs for one run insert once', async () => {
    const org = await m.org('Racing');
    const { run: started } = await startManagedIssuer(m.ctx, { orgId: org.id, createdBy: null });
    const before = posts().length;
    await Promise.all([
      runManagedIssuer(m.ctx, started.runId),
      runManagedIssuer(m.ctx, started.runId),
    ]);
    expect(posts()).toHaveLength(before + 1);
    expect((await run(started.runId))?.state).toBe('succeeded');
  });

  it('does not adopt a same-named issuer another org already holds', async () => {
    const first1 = await m.org('Twin');
    const second = await m.org('Twin');
    const a = await startManagedIssuer(m.ctx, { orgId: first1.id, createdBy: null });
    await runManagedIssuer(m.ctx, a.run.runId);
    const b = await startManagedIssuer(m.ctx, { orgId: second.id, createdBy: null });
    await runManagedIssuer(m.ctx, b.run.runId);
    const x = await latestManagedRun(m.ctx, first1.id);
    const y = await latestManagedRun(m.ctx, second.id);
    expect(x?.issuerId).toBeTruthy();
    expect(y?.issuerId).toBeTruthy();
    expect(x?.issuerId).not.toBe(y?.issuerId);
  });

  it('parks as google_manual_issuer without aggregator access; an admin completes it', async () => {
    m.stub.aggregator = false;
    const org = await m.org('Manual Inc');
    const other = await m.org('Other Inc');
    const { run: started } = await startManagedIssuer(m.ctx, { orgId: org.id, createdBy: null });
    await runManagedIssuer(m.ctx, started.runId);
    expect(await run(started.runId)).toMatchObject({
      state: 'waiting',
      waiting_for: 'google_manual_issuer',
    });
    // A parked run is not picked up again until it is completed.
    await runManagedIssuer(m.ctx, started.runId);
    expect((await run(started.runId))?.state).toBe('waiting');
    // Starting again returns the same open run.
    expect((await startManagedIssuer(m.ctx, { orgId: org.id, createdBy: null })).run.runId).toBe(
      started.runId,
    );

    const admin = await m.k.admin('live');
    // An issuer PassBook's service account cannot see is refused.
    await expect(
      completeManualIssuer(m.ctx, { orgId: org.id, issuerId: '9009', adminId: admin.user.id }),
    ).rejects.toMatchObject({ code: 'GOOGLE_ISSUER_NOT_SHARED' });
    // So is a run that is not waiting.
    await expect(
      completeManualIssuer(m.ctx, { orgId: other.id, issuerId: '9001', adminId: admin.user.id }),
    ).rejects.toMatchObject({ code: 'WALLET_ISSUER_NOT_WAITING' });

    // An issuer another org holds is refused.
    const holder = await m.org('Holder');
    m.stub.issuers.set('9005', 'Held');
    await sql(
      m.k.env.DB,
      "INSERT INTO wallet_google_issuers (issuer_id, org_id, origin, claimed_at) VALUES ('9005', ?, 'created', 1)",
      [holder.id],
    );
    await expect(
      completeManualIssuer(m.ctx, { orgId: org.id, issuerId: '9005', adminId: admin.user.id }),
    ).rejects.toMatchObject({ code: 'WALLET_ISSUER_CLAIMED' });

    m.stub.issuers.set('9001', 'Console made');
    const sentBefore = m.sent.length;
    const done = await completeManualIssuer(m.ctx, {
      orgId: org.id,
      issuerId: '9001',
      adminId: admin.user.id,
    });
    expect(done.state).toBe('queued');
    expect(m.sent.length).toBe(sentBefore + 1);
    await runManagedIssuer(m.ctx, started.runId);
    expect((await run(started.runId))?.state).toBe('succeeded');
    expect((await activeOrgGoogle(m.k.env.DB, org.id, 'live'))?.identity_hint).toBe('9001');
    m.stub.aggregator = true;
  });

  it('closes the run when Google refuses the request for good', async () => {
    m.stub.listStatus = 400;
    const org = await m.org('Broken');
    const { run: started } = await startManagedIssuer(m.ctx, { orgId: org.id, createdBy: null });
    await runManagedIssuer(m.ctx, started.runId);
    m.stub.listStatus = null;
    expect(await run(started.runId)).toMatchObject({
      state: 'failed',
      error_code: 'GOOGLE_BAD_REQUEST',
    });
  });

  it('is for the org owner on the plan, and one org cannot start or read another’s', async () => {
    const org = await m.org('Owner Org');
    const stranger = await m.org('Stranger Org');
    const owner = await m.k.member(org.id, 'live');
    const outsider = await m.k.member(stranger.id, 'live');
    await expect(requestManagedIssuer(m.ctx, outsider.auth, org.id)).rejects.toMatchObject({
      status: 403,
    });
    const trial = await m.org('Trial Org', 'trial');
    const trialOwner = await m.k.member(trial.id, 'live');
    await expect(requestManagedIssuer(m.ctx, trialOwner.auth, trial.id)).rejects.toMatchObject({
      status: 403,
    });
    const testMode = await m.k.member(org.id, 'test');
    await expect(requestManagedIssuer(m.ctx, testMode.auth, org.id)).rejects.toMatchObject({
      code: 'WALLET_MODE_MISMATCH',
    });
    const started = await requestManagedIssuer(m.ctx, owner.auth, org.id);
    await runManagedIssuer(m.ctx, started.runId);
    // The other org sees none of it.
    expect(await latestManagedRun(m.ctx, stranger.id)).toBeNull();
    expect((await listOrgCredentials(m.ctx, outsider.auth, stranger.id)).items).toHaveLength(0);
    // Reading the run by the other org's id returns nothing of this one.
    expect(await activeOrgGoogle(m.k.env.DB, stranger.id, 'live')).toBeNull();
    expect((await listOrgCredentials(m.ctx, owner.auth, org.id)).items).toMatchObject([
      { provenance: 'managed' },
    ]);
  });
});
