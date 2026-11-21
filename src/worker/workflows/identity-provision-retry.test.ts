import { afterEach, describe, expect, it, vi } from 'vitest';
import { listCertificateRows } from '../modules/identities/repo-certificates.ts';
import { startProvision, startRotation } from '../modules/identities/run-start.ts';
import { all, first } from '../platform/db.ts';
import { fakeStep, type Harness, harness } from './identity-provision-test-fixtures.ts';

const DAY = 86_400_000;
const PROVISION_STEPS = [
  'load',
  'handle',
  'pass-type-0',
  'key',
  'issue-0',
  'validate',
  'activate',
  'default',
  'post-check',
  'finish',
];

afterEach(() => vi.restoreAllMocks());

const identityId = async (h: Harness) =>
  (
    await first<{ id: string }>(h.env.DB, 'SELECT id FROM signing_identities WHERE org_id = ?', [
      h.org.id,
    ])
  )?.id ?? '';

const auditCount = async (h: Harness, action: string) =>
  (
    await first<{ n: number }>(
      h.env.DB,
      'SELECT count(*) AS n FROM audit_log WHERE org_id = ? AND action = ?',
      [h.org.id, action],
    )
  )?.n;

async function expectProvisioned(h: Harness, runId: string) {
  expect((await h.runRow(runId)).state).toBe('succeeded');
  const id = await identityId(h);
  const certs = await listCertificateRows(h.env.DB, id);
  expect(certs.map((c) => c.state)).toEqual(['active']);
  expect(h.apple.count('createPassType')).toBe(1);
  expect(h.apple.count('createCertificate')).toBe(1);
  expect(
    (
      await first<{ n: number }>(
        h.env.DB,
        'SELECT count(*) AS n FROM signing_identities WHERE org_id = ?',
        [h.org.id],
      )
    )?.n,
  ).toBe(1);
  for (const action of [
    'identity.provision_requested',
    'identity.pass_type_created',
    'identity.certificate_issued',
    'identity.provisioned',
  ])
    expect(await auditCount(h, action), action).toBe(1);
}

describe('adopt on retry', () => {
  it.each(PROVISION_STEPS)('runs %s twice without a second effect', async (name) => {
    const h = await harness(`twice-${name}`);
    const { runId } = await startProvision(h.kit.ctx, { orgId: h.org.id, createdBy: null });
    expect(await h.start(runId, fakeStep({ twice: [name] }))).toEqual({ state: 'succeeded' });
    await expectProvisioned(h, runId);
  });

  it('runs every step twice', async () => {
    const h = await harness('twice-all');
    const { runId } = await startProvision(h.kit.ctx, { orgId: h.org.id, createdBy: null });
    expect(await h.start(runId, fakeStep({ twice: 'all' }))).toEqual({ state: 'succeeded' });
    await expectProvisioned(h, runId);
  });

  it('adopts the pass type when the response of the create was lost', async () => {
    const h = await harness('drop-pass-type');
    h.apple.dropNext = 'createPassType';
    const { runId } = await startProvision(h.kit.ctx, { orgId: h.org.id, createdBy: null });
    expect(await h.start(runId)).toEqual({ state: 'succeeded' });
    await expectProvisioned(h, runId);
    expect(h.apple.count('findPassType')).toBe(2);
  });

  it('adopts the certificate when the response of the create was lost', async () => {
    const h = await harness('drop-cert');
    h.apple.dropNext = 'createCertificate';
    const { runId } = await startProvision(h.kit.ctx, { orgId: h.org.id, createdBy: null });
    expect(await h.start(runId)).toEqual({ state: 'succeeded' });
    await expectProvisioned(h, runId);
    expect(h.apple.count('listCertificates')).toBe(2);
  });

  it('rotates with every step run twice and a lost certificate response', async () => {
    const h = await harness('rotate-twice');
    const first1 = await startProvision(h.kit.ctx, { orgId: h.org.id, createdBy: null });
    await h.start(first1.runId);
    const id = await identityId(h);
    h.kit.clock.advance(300 * DAY);
    h.apple.dropNext = 'createCertificate';
    const { runId } = await startRotation(h.kit.ctx, { identityId: id, createdBy: null });
    expect(await h.start(runId, fakeStep({ twice: 'all' }))).toEqual({ state: 'succeeded' });
    expect((await listCertificateRows(h.env.DB, id)).map((c) => c.state)).toEqual([
      'superseded',
      'active',
    ]);
    expect(h.apple.count('createCertificate')).toBe(2);
    expect(await auditCount(h, 'identity.rotated')).toBe(1);
  });
});

describe('Apple unavailable', () => {
  it('parks the run as waiting and tries again each day', async () => {
    const h = await harness('parked');
    h.setApple(false);
    const { runId } = await startProvision(h.kit.ctx, { orgId: h.org.id, createdBy: null });
    const seen: unknown[] = [];
    const step = fakeStep({
      onSleep: async () => {
        const row = await h.runRow(runId);
        seen.push([row.state, row.waiting_for, row.error_code]);
        if (seen.length === 2) h.setApple(true);
      },
    });
    expect(await h.start(runId, step)).toEqual({ state: 'succeeded' });
    expect(seen).toEqual([
      ['waiting', 'apple_unavailable', null],
      ['waiting', 'apple_unavailable', null],
    ]);
    expect(step.sleeps).toEqual(['pass-type-wait-0', 'pass-type-wait-1']);
    await expectProvisioned(h, runId);
  });

  it('gives up after 45 daily tries with a stable code', async () => {
    const h = await harness('parked-forever');
    h.setApple(false);
    const { runId } = await startProvision(h.kit.ctx, { orgId: h.org.id, createdBy: null });
    const step = fakeStep();
    expect(await h.start(runId, step)).toEqual({ state: 'failed' });
    expect(step.sleeps).toHaveLength(45);
    expect(await h.runRow(runId)).toMatchObject({ state: 'failed', error_code: 'ASC_UNAVAILABLE' });
  });
});

describe('secrets', () => {
  it('never reaches a log line, an audit row or the run', async () => {
    const lines: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error'] as const)
      vi.spyOn(console, level).mockImplementation((...args) => void lines.push(args.join(' ')));
    const h = await harness('quiet-co');
    const { runId } = await startProvision(h.kit.ctx, { orgId: h.org.id, createdBy: null });
    await h.start(runId);
    h.kit.clock.advance(300 * DAY);
    h.apple.dropNext = 'createCertificate';
    const id = await identityId(h);
    const rotation = await startRotation(h.kit.ctx, { identityId: id, createdBy: null });
    await h.start(rotation.runId);
    const failing = await harness('quiet-fail');
    failing.setApple(false);
    const f = await startProvision(failing.kit.ctx, { orgId: failing.org.id, createdBy: null });
    await failing.start(f.runId);

    const audit = (
      await all<{ detail: string | null }>(h.env.DB, 'SELECT detail FROM audit_log')
    ).map((r) => r.detail ?? '');
    const runs = (
      await all<{ external_ref: string | null }>(h.env.DB, 'SELECT external_ref FROM identity_runs')
    ).map((r) => r.external_ref ?? '');
    expect(lines.some((l) => l.includes('identity.cert_activated'))).toBe(true);
    for (const text of [...lines, ...audit, ...runs]) {
      expect(text).not.toMatch(/PRIVATE KEY|BEGIN CERTIFICATE|MIIE[uvw]/);
    }
  });
});
