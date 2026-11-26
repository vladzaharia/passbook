import { describe, expect, it, vi } from 'vitest';
import { makeSession } from '../../../../test/helpers/index.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { readable } from '../operations/service.ts';
import { cancelOperation, retryOperation } from '../operations/service-act.ts';
import { setup } from './holder-operations-fixtures.ts';

const fail = vi.hoisted(() => ({ start: false }));
vi.mock('./operations-start.ts', async (original) => {
  const real = await original<typeof import('./operations-start.ts')>();
  return {
    ...real,
    startHolderOperation: (...args: Parameters<typeof real.startHolderOperation>) => {
      if (fail.start) throw new Error('operation insert failed');
      return real.startHolderOperation(...args);
    },
  };
});

const MIN = 60_000;

describe('lost phone signs the other devices out before any bookkeeping', () => {
  it("the finder's session is gone even when the operation cannot be recorded", async () => {
    const s = await setup();
    const finder = await s.session(s.user.id);
    fail.start = true;
    const res = await s.post(`/passes/${s.pass.id}/lost-phone`);
    fail.start = false;
    expect(res.status).toBe(500);
    // The code was replaced and the other session ended: the failure came after, in the record of it.
    const stolen = await s.read('nothing', finder.headers);
    expect(stolen.status).toBe(401);
  });
});

describe('lost phone needs a fresh email confirmation', () => {
  it('refuses a session that is not an email link from the last 10 minutes, and changes nothing', async () => {
    const s = await setup();
    const before = s.pass.scanCode;
    // The finder's session: an email link, but 11 minutes old.
    s.kit.clock.advance(11 * MIN);
    const res = await s.post(`/passes/${s.pass.id}/lost-phone`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'EMAIL_CONFIRMATION_REQUIRED' });
    const row = await s.kit.env.DB.prepare('SELECT scan_code FROM passes WHERE id = ?')
      .bind(s.pass.id)
      .first<{ scan_code: string }>();
    expect(row?.scan_code).toBe(before);
  });

  it('refuses a Polaris ID session even when it is new', async () => {
    const s = await setup();
    const oidc = await makeSession(s.kit.fx, { userId: s.user.id, amr: 'oidc' });
    const res = await s.post(`/passes/${s.pass.id}/lost-phone`, oidc.headers);
    expect(res.status).toBe(409);
  });

  it('mails the owner a link that lands back on the pass, then a fresh session runs it and is the one kept', async () => {
    const s = await setup();
    s.kit.clock.advance(11 * MIN);
    const res = await s.post(`/passes/${s.pass.id}/lost-phone/confirmation`);
    expect(res.status).toBe(202);
    const link = await s.kit.env.DB.prepare(
      'SELECT redirect_path, user_id, browser_binding_hash FROM magic_links WHERE user_id = ?',
    )
      .bind(s.user.id)
      .first<{ redirect_path: string; user_id: string; browser_binding_hash: string }>();
    expect(link?.redirect_path).toBe(`/passes/${s.pass.id}?lostPhone=${s.pass.id}`);
    expect(link?.browser_binding_hash).toBeTruthy();
    // Opening it signs in a new session in that browser: fresh, so the action runs from it and it stays.
    const fresh = await s.session(s.user.id);
    const run = await s.post(`/passes/${s.pass.id}/lost-phone`, fresh.headers);
    expect(run.status).toBe(202);
    expect((await s.read('x', fresh.headers)).status).toBe(404);
    expect((await s.read('x', s.mine.headers)).status).toBe(401);
  });

  it('will not mail the link for a pass that is not the caller own', async () => {
    const s = await setup();
    const res = await s.post(`/passes/${s.theirs.id}/lost-phone/confirmation`);
    expect(res.status).toBe(404);
  });
});

describe('a second device', () => {
  it('is told it runs on another device, with no operation it cannot read', async () => {
    const s = await setup();
    const other = await s.session(s.user.id);
    const first = await s.post(`/passes/${s.pass.id}/resend`);
    expect(first.status).toBe(202);
    const again = await s.post(`/passes/${s.pass.id}/resend`, other.headers);
    expect(again.status).toBe(409);
    const body = (await again.json()) as { code: string; detail: string; operationId?: string };
    expect(body.code).toBe('OPERATION_RUNNING');
    expect(body.operationId).toBeUndefined();
    expect(JSON.stringify(body)).toContain('another device');
  });

  it('joins a running refresh quietly', async () => {
    const s = await setup();
    const other = await s.session(s.user.id);
    expect((await s.post(`/passes/${s.pass.id}/refresh`)).status).toBe(202);
    const res = await s.post(`/passes/${s.pass.id}/refresh`, other.headers);
    expect(res.status).toBe(202);
    expect(((await res.json()) as { operationId?: string }).operationId).toBeUndefined();
  });
});

describe('an own-only session never stops or retries', () => {
  it('is refused in the service, not only at the route', async () => {
    const s = await setup();
    const { operationId } = (await (await s.post(`/passes/${s.pass.id}/resend`)).json()) as {
      operationId: string;
    };
    const holder = {
      kind: 'session',
      userId: s.user.id,
      sessionId: await sha256Hex(s.mine.cookieValue),
      roles: ['user'],
      amr: 'magic_link',
      csrfSecret: 'x',
      consoleAccess: false,
    } as unknown as SessionAuth;
    // The fence itself: a writer needs a strong session, so an own-only one reads but never writes.
    await expect(readable(s.kit.ctx, holder, operationId, 'read')).resolves.toBeDefined();
    await expect(readable(s.kit.ctx, holder, operationId, 'write')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(cancelOperation(s.kit.ctx, holder, operationId)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(retryOperation(s.kit.ctx, holder, operationId)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});
