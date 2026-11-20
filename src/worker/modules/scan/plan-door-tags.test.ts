// MT4a review M3: a tag already bound keeps admitting after the plan drops NFC; a new bind is refused.
import { beforeAll, describe, expect, it } from 'vitest';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { run } from '../../platform/db.ts';
import { type TagScanFixture, tagScanFixture } from './tags-scan-test-fixtures.ts';
import { key } from './test-kit.ts';

let f: TagScanFixture;
beforeAll(async () => {
  f = await tagScanFixture();
});

const nfc = (value: string) =>
  run(
    f.kit.env.DB,
    `INSERT OR REPLACE INTO org_entitlement_overrides (org_id, key, value, updated_at)
     VALUES (?, 'nfc', ?, 1)`,
    [f.kit.org.id, JSON.stringify(value)],
  );
const resolve = async (headers: Record<string, string>, tag: unknown) =>
  (await (
    await f.kit.post(headers, '/resolve', {
      idempotencyKey: key(),
      input: { tag, method: 'nfc' },
      clientTs: f.kit.clock.now(),
    })
  ).json()) as ScanOutcome;

describe('a tag after the plan drops NFC', () => {
  it('still admits at the door, while a new bind is refused with FEATURE_NOT_INCLUDED', async () => {
    const s = await f.desk();
    const { pass, card } = await f.pass();
    const tag = f.read();
    expect((await f.bind(s, { card, tag })).status).toBe(200);
    const before = await resolve(s.headers, tag);
    expect(before.kind).not.toBe('refused');

    await nfc('off');
    const after = await resolve(s.headers, tag);
    expect(after.kind).not.toBe('refused');
    expect(after.card).not.toBeNull();
    expect((await f.active()).filter((b) => b.pass_id === pass.id)).toHaveLength(1);

    const other = await f.pass();
    const res = await f.bind(s, { card: other.card, tag: f.read() });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'FEATURE_NOT_INCLUDED', feature: 'nfc' });
  });

  it('a switch the org turned off still stops the tag: only the plan is set aside', async () => {
    const s = await f.desk();
    const { card } = await f.pass();
    const tag = f.read();
    await nfc('secure');
    expect((await f.bind(s, { card, tag })).status).toBe(200);
    await nfc('off');
    await run(
      f.kit.env.DB,
      "UPDATE settings SET value = '{\"enabled\":false}' WHERE scope = ? AND key = 'nfc.tags'",
      [`org:${f.kit.org.id}`],
    );
    expect(await resolve(s.headers, tag)).toMatchObject({
      kind: 'refused',
      reason: 'tag_not_allowed',
    });
  });
});
