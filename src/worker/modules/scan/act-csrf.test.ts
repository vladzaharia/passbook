import { beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { first } from '../../platform/db.ts';
import { codeOf, key, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
beforeAll(async () => {
  kit = await setupScanKit();
});

/*
 * The action's CSRF check is the guard's (`csrfGuard`: the header equals the stored secret) plus the
 * grant's: a scanner's secret is a credential-epoch column, a session's is immutable (0047). The
 * scalar re-reads that used to follow the guard are gone; these keep the check itself.
 */
describe('POST /actions CSRF', () => {
  it('refuses a request whose CSRF token is not the scanner secret, and records nothing', async () => {
    const templateId = await kit.scanTemplate('CSRF act', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const pass = await kit.scanPass(templateId);
    const idempotencyKey = key();
    const body = {
      idempotencyKey,
      input: codeOf(pass),
      clientTs: kit.clock.now(),
      actionId: 'check_in',
    };
    for (const token of [undefined, 'not-the-secret']) {
      const headers = { ...scanner.headers };
      if (token === undefined) delete headers['x-csrf-token'];
      else headers['x-csrf-token'] = token;
      await expectProblem(await kit.post(headers, '/actions', body), 403, 'CSRF_TOKEN');
    }
    expect(
      await first(kit.env.DB, 'SELECT id FROM scans WHERE idempotency_key = ?', [idempotencyKey]),
    ).toBeNull();
    // Positive control: the same request with the scanner's own token acts.
    const ok = await kit.post(scanner.headers, '/actions', body);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ kind: 'ok' });
  });

  it('refuses an admin session request with a wrong CSRF token, and acts with its own', async () => {
    const templateId = await kit.scanTemplate('CSRF admin act', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    const pass = await kit.scanPass(templateId);
    const idempotencyKey = key();
    const body = {
      scope: { orgId: kit.org.id, timeZone: 'UTC' },
      idempotencyKey,
      input: codeOf(pass),
      clientTs: kit.clock.now(),
      actionId: 'check_in',
    };
    const admin = kit.admin();
    for (const token of [undefined, 'not-the-secret']) {
      const headers = { ...admin };
      if (token === undefined) delete headers['x-csrf-token'];
      else headers['x-csrf-token'] = token;
      await expectProblem(await kit.post(headers, '/actions', body), 403, 'CSRF_TOKEN');
    }
    expect(
      await first(kit.env.DB, 'SELECT id FROM scans WHERE idempotency_key = ?', [idempotencyKey]),
    ).toBeNull();
    const ok = await kit.post(admin, '/actions', body);
    expect(ok.status, await ok.clone().text()).toBe(200);
  });
});
