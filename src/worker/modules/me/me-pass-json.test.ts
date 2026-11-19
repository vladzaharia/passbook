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
      run(h.env.DB, 'UPDATE pass_versions SET pass_json = ? WHERE pass_id = ?', [
        '{"holder":"Jane Doe-Secret" oops',
        pass.id,
      ]),
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await read()).passJson).toEqual({});
    const logged = error.mock.calls.flat().join('\n');
    expect(logged).toContain('MY_PASS_JSON_INVALID');
    expect(logged).toContain('SyntaxError');
    expect(logged).not.toContain('Jane Doe-Secret');
  });

  it('logs a stuck pass as an error once, then as warnings', async () => {
    const { read } = await ownedPass();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await read();
    await read();
    await read();
    expect(error).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.flat().join('\n')).toContain('MY_PASS_JSON_MISSING');
  });

  it('strips barcodes from a pass that cannot be presented on the fallback path too', async () => {
    const { pass, read } = await ownedPass();
    const barcode = { format: 'PKBarcodeFormatQR', message: 'secret', messageEncoding: 'utf-8' };
    await run(h.env.DB, 'UPDATE pass_versions SET pass_json = ? WHERE pass_id = ?', [
      JSON.stringify({ description: 'Old', barcode, barcodes: [barcode] }),
      pass.id,
    ]);
    await run(h.env.DB, 'UPDATE passes SET version = version + 1 WHERE id = ?', [pass.id]);
    expect((await read()).passJson).toMatchObject({ barcodes: [{ message: 'secret' }] });
    await run(h.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [pass.id]);
    const body = (await read()).passJson;
    expect(body).toMatchObject({ description: 'Old' });
    expect(body).not.toHaveProperty('barcode');
    expect(body).not.toHaveProperty('barcodes');
  });
});
