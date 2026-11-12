import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  makeScanEvent,
  makeTemplate,
  makeUser,
  persistTemplate,
} from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { ensurePlatformIdentity } from '../identities/repo.ts';
import { overrideDeps } from '../passes/deps.ts';
import { createScannerStore } from './auth-store.ts';
import {
  admin,
  auditActions,
  clock,
  codeOf,
  consoleCall,
  cookieOf,
  create,
  env,
  f,
  fake,
  orgId,
  pairCall,
  send,
  setupScannerFixture,
  templateId,
} from './scanners-split-test-fixtures.ts';
import { grantScanMembership } from './test-kit.ts';

setupScannerFixture();

describe('revoke and mode', () => {
  it('revoke bites on the next request, keeps the token matching, and Pair again reactivates', async () => {
    const { body } = await create();
    const token = cookieOf(await pairCall('', body.pairing?.code ?? '')).token;
    const store = createScannerStore(env, clock);
    expect(await store.resolve(token, 'cookie')).not.toBeNull();
    const res = await consoleCall('POST', `/${body.id}/revoke`);
    expect(((await res.json()) as { status: string }).status).toBe('revoked');
    await expect(store.resolve(token, 'cookie')).rejects.toMatchObject({ code: 'SCANNER_REVOKED' });
    expect((await consoleCall('POST', `/${body.id}/revoke`)).status).toBe(200);
    expect((await auditActions()).filter((a) => a === 'scanner.revoke')).toHaveLength(1);
    const refused = await consoleCall('POST', `/${body.id}/pairing`);
    expect(refused.status).toBe(409);
    expect(await codeOf(refused)).toBe('SCANNER_REVOKED');
    expect((await consoleCall('POST', `/${body.id}/pair-here`)).status).toBe(409);
    const fresh = (await (
      await consoleCall('POST', `/${body.id}/pairing?restore=true`)
    ).json()) as { code: string };
    expect(await auditActions()).toContain('scanner.restore');
    const again = cookieOf(await pairCall('', fresh.code)).token;
    expect(await store.resolve(token, 'cookie')).toBeNull();
    expect((await store.resolve(again, 'cookie'))?.scannerId).toBe(body.id);
  });

  it("a revoked scanner's pending code is void", async () => {
    const { body } = await create();
    await consoleCall('POST', `/${body.id}/revoke`);
    expect((await pairCall('/preview', body.pairing?.code ?? '')).status).toBe(400);
  });

  it('Go live keeps the token and bumps configRev', async () => {
    const { body } = await create({ accepts: { templateIds: [templateId] } }, admin('test'));
    const token = cookieOf(await pairCall('', body.pairing?.code ?? '')).token;
    const before = await first<{ updated_at: number }>(
      env.DB,
      'SELECT updated_at FROM scanners WHERE id = ?',
      [body.id],
    );
    clock.advance(5_000);
    const res = await consoleCall('POST', `/${body.id}/mode`, { mode: 'live' }, admin('test'));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { mode: string }).mode).toBe('live');
    const store = createScannerStore(env, clock);
    expect(await store.resolve(token, 'cookie')).toMatchObject({ mode: 'live' });
    const after = await first<{ updated_at: number }>(
      env.DB,
      'SELECT updated_at FROM scanners WHERE id = ?',
      [body.id],
    );
    expect(before).not.toBeNull();
    expect(after?.updated_at).toBe(Math.max(clock.now(), (before?.updated_at ?? 0) + 1));
    expect(after?.updated_at).toBeGreaterThan(before?.updated_at ?? 0);
  });

  it('Go live is refused on an event of the old mode unless the event is detached in the call', async () => {
    const event = await makeScanEvent(f, { orgId, mode: 'test', templateIds: [templateId] });
    const { body } = await create({ accepts: { eventId: event.id } }, admin('test'));
    const refused = await consoleCall('POST', `/${body.id}/mode`, { mode: 'live' }, admin('test'));
    expect(refused.status).toBe(422);
    expect(await codeOf(refused)).toBe('SCAN_MODE_MISMATCH');
    const ok = await consoleCall(
      'POST',
      `/${body.id}/mode`,
      { mode: 'live', detachEvent: true },
      admin('test'),
    );
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { accepts: unknown }).accepts).toBeNull();
    expect(
      await first(env.DB, 'SELECT 1 AS x FROM scanners WHERE id = ? AND event_id IS NULL', [
        body.id,
      ]),
    ).not.toBeNull();
  });
});

describe('sample pass', () => {
  it('is for test scanners only', async () => {
    const { body } = await create();
    const res = await consoleCall('POST', `/${body.id}/sample-pass`);
    expect(res.status).toBe(422);
    expect(await codeOf(res)).toBe('SAMPLE_TEST_ONLY');
  });

  it('makes one test pass of the first accepted template with its sample inputs', async () => {
    clock.set(Date.now());
    const made = makeTemplate({ id: f.ids.id(), orgId });
    await persistTemplate(f, made.resolved, { registry: made.registry });
    overrideDeps(env, { registry: made.registry });
    await ensurePlatformIdentity(env, clock.now());
    const reviewer = await makeUser(f);
    await grantScanMembership(f, orgId, reviewer.id);
    const reviewerHeaders = fake.session({
      userId: reviewer.id,
      roles: ['admin', 'user'],
      mode: 'test',
    });
    const scope = { orgId, mode: 'test', provider: 'apple' };
    const base = `/api/v1/templates/${made.resolved.id}`;
    const candidateResponse = await send('POST', `${base}/candidates`, admin('test'), {
      ...scope,
      version: made.resolved.version,
    });
    expect(candidateResponse.status).toBe(201);
    const candidate = (await candidateResponse.json()) as { id: string; candidateHash: string };
    const approvalResponse = await send(
      'POST',
      `${base}/candidates/${candidate.id}/approve`,
      reviewerHeaders,
      { ...scope, candidateHash: candidate.candidateHash },
    );
    expect(approvalResponse.status).toBe(201);
    const approval = (await approvalResponse.json()) as { id: string };
    const releaseResponse = await send('POST', `${base}/releases`, admin('test'), {
      ...scope,
      candidateId: candidate.id,
      approvalId: approval.id,
      candidateHash: candidate.candidateHash,
      expectedGeneration: 0,
    });
    expect(releaseResponse.status).toBe(201);
    const { body } = await create({ accepts: { templateIds: [made.resolved.id] } }, admin('test'));
    const res = await consoleCall('POST', `/${body.id}/sample-pass`);
    expect(res.status).toBe(201);
    const sample = (await res.json()) as { passId: string; templateId: string };
    expect(sample.templateId).toBe(made.resolved.id);
    const pass = await first<{
      mode: string;
      holder_email: string | null;
      personalization: string;
    }>(env.DB, 'SELECT mode, holder_email, personalization FROM passes WHERE id = ?', [
      sample.passId,
    ]);
    expect(pass?.mode).toBe('test');
    expect(pass?.holder_email).toBeNull();
    expect(JSON.parse(pass?.personalization ?? '{}')).toEqual({ memberName: 'Alex Morgan' });
    expect(await auditActions()).toContain('scanner.sample_pass');
  });
});

describe('audit and secrets', () => {
  const spies: ReturnType<typeof vi.spyOn>[] = [];
  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
  });

  it('writes the audit rows of SA 2.11 and never the pairing code or a token', async () => {
    const lines: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error'] as const)
      spies.push(
        vi
          .spyOn(console, level)
          .mockImplementation((line: unknown) => void lines.push(String(line))),
      );
    const { body } = await create({ name: 'Audit' });
    const code = body.pairing?.code ?? '';
    await pairCall('/preview', code);
    await pairCall('', 'ABCDEFGHJK');
    const token = cookieOf(await pairCall('', code)).token;
    await consoleCall('PATCH', `/${body.id}`, { name: 'Audit 2' });
    await consoleCall('POST', `/${body.id}/mode`, { mode: 'test' });
    await consoleCall('POST', `/${body.id}/revoke`, undefined, admin('test'));
    const actions = await auditActions();
    expect(actions).toEqual(
      expect.arrayContaining([
        'scanner.create',
        'scanner.pairing_create',
        'scanner.pair_failed',
        'scanner.pair',
        'scanner.update',
        'scanner.mode_change',
        'scanner.revoke',
      ]),
    );
    const rows = await all<{ actor_type: string; detail: string | null; org_id: string | null }>(
      env.DB,
      'SELECT actor_type, detail, org_id FROM audit_log',
    );
    const blob = JSON.stringify(rows) + lines.join('\n');
    expect(blob).not.toContain(code);
    expect(blob).not.toContain('ABCDEFGHJK');
    expect(blob).not.toContain(token);
    expect(blob).not.toContain(token.slice(4, 12));
    const pair = await first<{ actor_type: string; org_id: string }>(
      env.DB,
      "SELECT actor_type, org_id FROM audit_log WHERE action = 'scanner.pair'",
    );
    expect(pair).toEqual({ actor_type: 'scanner', org_id: orgId });
  });

  it('commits a change and its audit row together', async () => {
    await run(
      env.DB,
      "CREATE TRIGGER fail_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit down'); END",
    );
    try {
      const { res } = await create({ name: 'Atomic' });
      expect(res.status).toBe(500);
      expect(await first(env.DB, "SELECT 1 AS x FROM scanners WHERE name = 'Atomic'")).toBeNull();
    } finally {
      await run(env.DB, 'DROP TRIGGER fail_audit');
    }
  });
});
