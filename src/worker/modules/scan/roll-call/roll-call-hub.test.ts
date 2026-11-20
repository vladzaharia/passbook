import { beforeAll, describe, expect, it } from 'vitest';
import { type EnrollFixture, enrollFixture } from '../tags-enroll-test-fixtures.ts';

let f: EnrollFixture;
beforeAll(async () => {
  f = await enrollFixture();
});

const bell = { rollCall: { id: 'call-1', rev: 3, ended: false } };

describe('the roll call doorbell', () => {
  it('rings every connected device of the hub, with an id and a revision and no names', async () => {
    const a = await f.device('desk');
    const b = await f.device('desk');
    const [sa, sb] = [await f.connect(a.id), await f.connect(b.id)];
    const sent = await f.hub().stub.toDevice({ orgId: f.kit.org.id, mode: 'live' }, bell, false);
    expect(sent).toBeGreaterThanOrEqual(2);
    await f.wait();
    for (const s of [sa, sb]) expect(s.messages.at(-1)).toEqual(bell);
    sa.socket.close(1000);
    sb.socket.close(1000);
  });

  it('does not cross to the other mode, whose hub is another object', async () => {
    const a = await f.device('desk');
    const sa = await f.connect(a.id);
    const before = sa.messages.length;
    expect(await f.hub().stub.toDevice({ orgId: f.kit.org.id, mode: 'test' }, bell, false)).toBe(0);
    await f.wait();
    expect(sa.messages).toHaveLength(before);
    sa.socket.close(1000);
  });
});
