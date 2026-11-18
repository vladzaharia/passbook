import { unzipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import { first } from '../../platform/db.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { act, kit, MINUTE, out, reviseReplayTemplate, tpl } from './act-test-fixtures.ts';
import { codeOf, key } from './test-kit.ts';

let termTpl: string;

beforeAll(async () => {
  const { setupActionFixture } = await import('./act-test-fixtures.ts');
  await setupActionFixture();
  termTpl = tpl;
  await reviseReplayTemplate(termTpl, (m) => {
    m.behaviors = [
      {
        use: 'term',
        version: 1,
        config: { start: 'startsAt', firstScan: true, unit: 'months', length: 12 },
      },
    ];
  });
});

async function stored(passId: string) {
  const pass = await getPass(kit.env.DB, passId);
  if (!pass) throw new Error('missing pass');
  const object = await kit.env.BUCKET.get(pass.objectKey);
  const files = unzipSync(new Uint8Array((await object?.arrayBuffer()) ?? new ArrayBuffer(0)));
  const json = JSON.parse(new TextDecoder().decode(files['pass.json'])) as {
    expirationDate?: string;
  };
  return { start: pass.personalization.startsAt, expires: json.expirationDate, pass };
}

describe('term: first scan', () => {
  it('stamps the start at the first scan and re-signs with the end', async () => {
    const s = await kit.scanner({ templateIds: [termTpl] });
    const pass = await kit.scanPass(termTpl);
    expect((await stored(pass.id)).expires).toBeUndefined();
    const at = kit.clock.now();
    const o = await out(await act(s.headers, codeOf(pass)));
    expect(o.kind).toBe('ok');
    const after = await stored(pass.id);
    expect(after.start).toBe(new Date(at).toISOString());
    const end = new Date(at);
    end.setUTCFullYear(end.getUTCFullYear() + 1);
    expect(after.expires).toBe(end.toISOString().replace('.000Z', 'Z'));
    expect(after.pass.version).toBe(pass.version + 1);
  });

  it('leaves the start where it is on a second scan, a retry and an override', async () => {
    const a = await kit.scanner({ templateIds: [termTpl] });
    const b = await kit.scanner({ templateIds: [termTpl] });
    const pass = await kit.scanPass(termTpl);
    const request = { idempotencyKey: key() };
    const first1 = await out(await act(a.headers, codeOf(pass), request));
    const before = await stored(pass.id);
    kit.clock.advance(5 * MINUTE);
    await act(a.headers, codeOf(pass), request);
    const second = await out(await act(b.headers, codeOf(pass)));
    expect(first1.kind).toBe('ok');
    expect(second.kind).toBe('heads_up');
    const after = await stored(pass.id);
    expect(before.start).toEqual(expect.any(String));
    expect(after.start).toBe(before.start);
    expect(after.expires).toBe(before.expires);
    expect(after.pass.version).toBe(before.pass.version);
  });

  it('keeps the stamp when the first scan is undone', async () => {
    const s = await kit.scanner({ templateIds: [termTpl] });
    const pass = await kit.scanPass(termTpl);
    const o = await out(await act(s.headers, codeOf(pass)));
    const before = await stored(pass.id);
    const res = await kit.post(s.headers, `/scans/${o.scanId}/undo`, { idempotencyKey: key() });
    expect(res.status).toBe(200);
    expect(
      await first(kit.env.DB, 'SELECT undone_by FROM scans WHERE id = ?', [o.scanId ?? '']),
    ).not.toEqual({ undone_by: null });
    const after = await stored(pass.id);
    expect(before.start).toEqual(expect.any(String));
    expect(after.start).toBe(before.start);
    expect(after.expires).toBe(before.expires);
  });

  it('does not stamp a template without a first-scan term', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const plain = await kit.scanTemplate('Plain', {
      actions: [{ id: 'check_in', label: 'In', kind: 'check_in' }],
    });
    const s2 = await kit.scanner({ templateIds: [plain] });
    const pass = await kit.scanPass(plain);
    await act(s2.headers, codeOf(pass));
    expect((await stored(pass.id)).start).toBeUndefined();
    expect(s.headers).toBeDefined();
  });
});
