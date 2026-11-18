import { beforeAll, describe, expect, it } from 'vitest';
import { all } from '../../platform/db.ts';
import { RateLimitedError } from '../../platform/errors.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { NEW_CODES_PER_HOUR, newPassCode } from '../holders/new-code.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { act, expectUnavailable, kit, out, setupActionFixture, tpl } from './act-test-fixtures.ts';
import { codeOf } from './test-kit.ts';

beforeAll(setupActionFixture);

const system = { type: 'system', id: null } as const;
const rotate = (passId: string) =>
  newPassCode(jobCtxOf({ ctx: kit.ctx }), system, { passId }, null);

describe('New code', () => {
  it('rotates the code: the old one is refused, the new one is admitted', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const before = codeOf(pass);
    expect((await out(await act(s.headers, before))).kind).toBe('ok');

    expect((await rotate(pass.id)).transfer).toMatchObject({ state: 'completed' });

    const after = await getPass(kit.env.DB, pass.id);
    expect(after?.scanCode).toMatch(/^[A-Z2-7]{26}$/);
    expect(after?.scanCode).not.toBe(pass.scanCode);
    expectUnavailable(await out(await act(s.headers, before)));
    expect(
      (await out(await act(s.headers, codeOf(after as never), { actionId: 'auto' }))).kind,
    ).not.toBe('refused');
  });

  it('writes an audit row without the code', async () => {
    const pass = await kit.scanPass(tpl);
    await rotate(pass.id);
    const rows = await all<{ action: string; actor_type: string; detail: string | null }>(
      kit.env.DB,
      "SELECT action, actor_type, detail FROM audit_log WHERE action = 'pass.new_code' AND target_id = ?",
      [pass.id],
    );
    expect(rows).toHaveLength(1);
    const now = await getPass(kit.env.DB, pass.id);
    const text = JSON.stringify(rows);
    expect(text).not.toContain(pass.scanCode as string);
    expect(text).not.toContain(now?.scanCode as string);
  });

  it('limits a pass to a few new codes an hour', async () => {
    const pass = await kit.scanPass(tpl);
    for (let i = 0; i < NEW_CODES_PER_HOUR; i++) await rotate(pass.id);
    await expect(rotate(pass.id)).rejects.toBeInstanceOf(RateLimitedError);
  });
});
