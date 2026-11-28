import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TEST_NOW } from '../../../../test/helpers/index.ts';
import { clearTypes, doorCalls } from './tags-policy-test-fixtures.ts';
import { type TagScanFixture, tagScanFixture } from './tags-scan-test-fixtures.ts';

let f: TagScanFixture;
let door: ReturnType<typeof doorCalls>;
beforeAll(async () => {
  f = await tagScanFixture();
  door = doorCalls(f);
});
afterEach(async () => {
  await clearTypes(f);
  f.kit.clock.set(TEST_NOW);
});

const SOURCES = ['native', 'webnfc', 'reader', 'keyboard'] as const;

async function bound() {
  const s = await f.desk();
  const { card, pass } = await f.pass();
  const tag = f.read();
  expect((await f.bind(s, { card, tag })).status).toBe(200);
  return { tag, pass };
}

describe('tag source', () => {
  it('reader and keyboard reads resolve and act exactly like native ones', async () => {
    const { tag, pass } = await bound();
    const s = await f.desk();
    const base = await door.post(s, '/resolve', tag);
    expect(base).toMatchObject({ kind: 'ready' });
    for (const source of SOURCES) {
      const read = { ...tag, source };
      const out = await door.post(s, '/resolve', read);
      expect(out).toMatchObject({ kind: base.kind, card: { passId: pass.id } });
    }
    const acted: unknown[] = [];
    for (const source of SOURCES) {
      const fresh = await bound();
      const res = await door.post(s, '/actions', { ...fresh.tag, source });
      acted.push({ kind: res.kind, reason: res.reason });
    }
    expect(acted.every((a) => JSON.stringify(a) === JSON.stringify(acted[0]))).toBe(true);
    expect(acted[0]).toMatchObject({ kind: expect.stringMatching(/^(ok|done)$/) });
  });

  it('an unknown tag is not found whatever the source says', async () => {
    const s = await f.desk();
    for (const source of SOURCES)
      expect(await door.post(s, '/resolve', { ...f.read(), source })).toMatchObject({
        kind: 'refused',
        reason: 'not_found',
      });
  });

  it('a keyboard read still faces confirmBasic, and a Door still sees no tag data', async () => {
    const { tag } = await bound();
    const check = await f.desk({ tags: { confirmBasic: 'staff' } });
    for (const source of SOURCES)
      expect(await door.post(check, '/resolve', { ...tag, source })).toMatchObject({
        kind: 'heads_up',
        reason: 'check_required',
      });
    const d = await f.door();
    expect((await door.post(d, '/resolve', { ...tag, source: 'keyboard' })).tag).toBeUndefined();
  });

  it('a keyboard read with NDEF is refused at the boundary', async () => {
    const s = await f.desk();
    const res = await f.kit.post(s.headers, '/resolve', {
      idempotencyKey: crypto.randomUUID(),
      input: {
        method: 'nfc',
        tag: { tech: 'a', source: 'keyboard', ndef: { type: 'T', value: 'x' } },
      },
      clientTs: f.kit.clock.now(),
    });
    expect(res.status).toBe(422);
  });

  it('a UID-only reader or keyboard read is refused where Secure is required', async () => {
    const { tag } = await bound();
    const open = await f.desk();
    const secure = await f.desk({ tags: { level: 'secure' } });
    for (const source of ['reader', 'keyboard'] as const) {
      expect(await door.post(open, '/resolve', { ...tag, source })).toMatchObject({
        kind: 'ready',
      });
      const out = await door.post(secure, '/resolve', { ...tag, source });
      expect(out.kind).not.toBe('ready');
      expect(out.card ?? null).toBeNull();
    }
  });
});
