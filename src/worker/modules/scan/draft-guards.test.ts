import { beforeAll, describe, expect, it } from 'vitest';
import { fakeRateLimiter } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { call, desk, ec, flush, setupDraftFixture, state } from './draft-test-fixtures.ts';
import { DEFAULT_SETTINGS } from './dto-console.ts';
import { workspace } from './repo-session-activity-authority-test-fixtures.ts';
import { kit } from './scan-hub-test-fixtures.ts';
import { codeOf, key } from './test-kit.ts';

beforeAll(setupDraftFixture);

const body = (ref: string) => ({ ref, actionId: 'pay', amount: 5 });
const codeOfRes = async (res: Response) => ((await res.json()) as { code?: string }).code;

describe('PUT /draft guards', () => {
  it('has its own rate budget: draft until 429, and the commit still runs', async () => {
    const d = await desk();
    const { ref } = await d.read();
    const original = kit.env.RL_SCAN_DRAFT;
    Object.assign(kit.env, { RL_SCAN_DRAFT: fakeRateLimiter({ limit: 3 }) });
    try {
      for (let i = 0; i < 3; i++) expect((await d.draft(ref, 'pay', 5)).status).toBe(200);
      const refused = await d.draft(ref, 'pay', 5);
      expect(refused.status).toBe(429);
      expect((await d.act('pay', 12)).status).toBe(200);
    } finally {
      Object.assign(kit.env, { RL_SCAN_DRAFT: original });
    }
    d.close();
  });

  it('refuses a terminal, a staffless scanner and a desk role that may not take', async () => {
    const d = await desk();
    const { ref } = await d.read();
    const terminal = await kit.scanner({
      kind: 'terminal',
      templateIds: [state.money],
      settings: { roleWithoutSignIn: 'desk' },
    });
    const refusedTerminal = await call('PUT', terminal.headers, '/draft', body(ref));
    expect(refusedTerminal.status).toBe(403);
    expect(await codeOfRes(refusedTerminal)).toBe('DEVICE_REQUIRED');
    const staffed = await kit.scanner({
      templateIds: [state.money],
      settings: { staffSignIn: true },
    });
    const refusedStaffless = await call('PUT', staffed.headers, '/draft', body(ref));
    expect(refusedStaffless.status).toBe(403);
    expect(await codeOfRes(refusedStaffless)).toBe('STAFF_REQUIRED');
    const door = await kit.scanner({
      templateIds: [state.money],
      settings: { roleWithoutSignIn: 'door' },
    });
    const read = await kit.post(
      door.headers,
      '/resolve',
      { idempotencyKey: key(), input: codeOf(d.pass), clientTs: kit.clock.now() },
      ec as never,
    );
    await flush();
    expect(read.status).toBe(200);
    d.close();
  });

  it('is refused while the session is paused or closed', async () => {
    const d = await desk();
    await workspace(
      kit,
      d.source,
      { templateIds: [state.money] },
      {
        ...DEFAULT_SETTINGS,
        roleWithoutSignIn: 'desk',
      },
    );
    const { ref } = await d.read();
    expect((await d.draft(ref, 'pay', 5)).status).toBe(200);
    await run(
      kit.env.DB,
      "UPDATE scanning_sessions SET status='paused' WHERE id IN (SELECT session_id FROM scanning_devices WHERE scanner_id=?)",
      [d.source.id],
    );
    const paused = await d.draft(ref, 'pay', 5);
    expect(paused.status).toBe(403);
    expect(await codeOfRes(paused)).toBe('SCANNING_SESSION_PAUSED');
    await run(
      kit.env.DB,
      "UPDATE scanning_sessions SET status='active', hours=? WHERE id IN (SELECT session_id FROM scanning_devices WHERE scanner_id=?)",
      ['{"wed":["08:00-09:00"]}', d.source.id],
    );
    const now = kit.clock.now();
    kit.clock.set(Date.UTC(2026, 5, 3, 23));
    try {
      const closed = await d.draft(ref, 'pay', 5);
      expect(closed.status).toBe(403);
      expect(await codeOfRes(closed)).toBe('SCANNING_SESSION_CLOSED');
    } finally {
      kit.clock.set(now);
    }
    d.close();
  });
});
