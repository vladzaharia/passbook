import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fixtures,
  makeOrg,
  makePass,
  makeSession,
  makeTemplate,
  makeUser,
  withoutTrigger,
} from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { harness, type TestHarness } from '../auth/test-support.ts';

let h: TestHarness;
beforeEach(async () => {
  h = await harness();
});
afterEach(() => {
  vi.restoreAllMocks();
  h.restore();
});

async function ownedPass() {
  const f = fixtures(h.env, h.clock);
  const user = await makeUser(f);
  const session = await makeSession(f, { userId: user.id });
  const org = await makeOrg(f, { name: 'Acme' });
  const pass = await makePass(f, {
    orgId: org.id,
    template: makeTemplate().resolved,
    ownerUserId: user.id,
  });
  const read = async () =>
    (await (await h.call(`/api/v1/me/passes/${pass.id}`, { headers: session.headers })).json()) as {
      passJson: Record<string, unknown>;
    };
  return { pass, read };
}

describe('holder pass json', () => {
  it('renders the newest stored version when a metadata write raised the version past it', async () => {
    const { pass, read } = await ownedPass();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await run(h.env.DB, 'UPDATE pass_versions SET pass_json = ? WHERE pass_id = ?', [
      JSON.stringify({ description: 'Stored v1' }),
      pass.id,
    ]);
    // A sync or bind that stores no artifact still raises `version`.
    await run(h.env.DB, 'UPDATE passes SET version = version + 2 WHERE id = ?', [pass.id]);
    expect((await read()).passJson).toMatchObject({ description: 'Stored v1' });
    expect(error).not.toHaveBeenCalled();
  });

  it('logs and answers an empty pass when nothing is stored', async () => {
    const { read } = await ownedPass();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await read()).passJson).toEqual({});
    expect(error.mock.calls.flat().join('\n')).toContain('MY_PASS_JSON_MISSING');
  });

  it('stays quiet when the current version has its json', async () => {
    const { pass, read } = await ownedPass();
    await run(h.env.DB, 'UPDATE pass_versions SET pass_json = ? WHERE pass_id = ?', [
      JSON.stringify({ description: 'Fine' }),
      pass.id,
    ]);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await read()).passJson).toMatchObject({ description: 'Fine' });
    expect(error).not.toHaveBeenCalled();
  });

  it('logs stored json that does not parse', async () => {
    const { pass, read } = await ownedPass();
    await withoutTrigger(h.env.DB, 'pass_versions_no_auth_token_update', () =>
      run(h.env.DB, 'UPDATE pass_versions SET pass_json = ? WHERE pass_id = ?', ['{nope', pass.id]),
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await read()).passJson).toEqual({});
    expect(error.mock.calls.flat().join('\n')).toContain('MY_PASS_JSON_INVALID');
  });
});
