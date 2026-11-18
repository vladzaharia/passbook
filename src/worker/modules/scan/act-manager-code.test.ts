import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeScanStaff, TEST_NOW } from '../../../../test/helpers/index.ts';
import { act, kit, setupActionFixture } from './act-test-fixtures.ts';
import { codeOf } from './test-kit.ts';

beforeAll(setupActionFixture);
// PIN counters are windowed by the clock: each test starts in a fresh hour.
let tick = 0;
beforeEach(() => kit.clock.set(TEST_NOW + 100_000 * 60_000 + ++tick * 61 * 60_000));

const ADD = {
  id: 'add',
  label: 'Add',
  kind: 'add',
  input: 'balance',
  repeat: 'always',
  amount: 1,
} as const;

async function door() {
  const t = await kit.scanTemplate('Manager code', { actions: [ADD] });
  const s = await kit.scanner({ templateIds: [t] });
  const pass = await kit.scanPass(t, { balance: 0 });
  return (pin: string) => act(s.headers, codeOf(pass), { actionId: 'add', approval: { pin } });
}
const triesLeft = async (res: Response) =>
  ((await res.json()) as { issues?: { path: string; message: string }[] }).issues?.find(
    (i) => i.path === 'triesLeft',
  )?.message;

describe('manager code tries', () => {
  it('counts down from the real counter and then locks with the PIN marker', async () => {
    await makeScanStaff(kit.fx, { orgId: kit.org.id, role: 'manager', pin: '246810' });
    const add = await door();
    const left: (string | undefined)[] = [];
    let last: Response | undefined;
    for (let i = 0; i < 20; i++) {
      last = await add('000000');
      if (last.status !== 400) break;
      left.push(await triesLeft(last));
    }
    // Each wrong code reports one fewer try; the call after the last is the lockout.
    expect(left.length).toBeGreaterThan(0);
    expect(left.at(-1)).toBe('0');
    const numbers = left.map(Number);
    expect(numbers).toEqual([...numbers].sort((a, b) => b - a));
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(last?.status).toBe(429);
    expect(last?.headers.get('retry-after')).toMatch(/^\d+$/);
    const body = (await last?.json()) as { code: string; issues?: { path: string }[] };
    expect(body.code).toBe('RATE_LIMITED');
    expect(body.issues).toEqual([{ path: 'pin', message: 'locked' }]);
  });

  it('does not take the right code once locked', async () => {
    await makeScanStaff(kit.fx, { orgId: kit.org.id, role: 'manager', pin: '135790' });
    const add = await door();
    let status = 0;
    for (let i = 0; i < 20 && status !== 429; i++) status = (await add('000000')).status;
    expect(status).toBe(429);
    expect((await add('135790')).status).toBe(429);
  });

  it('reports the real wait: minutes for the person lock, longer for the hourly scanner lock', async () => {
    await makeScanStaff(kit.fx, { orgId: kit.org.id, role: 'manager', pin: '864209' });
    const HOUR = 3_600_000;
    // Start at the top of an hour so five-minute windows fit inside one hourly window.
    kit.clock.set(Math.ceil((kit.clock.now() + HOUR) / HOUR) * HOUR + 1000);
    const add = await door();
    const waits: number[] = [];
    for (let i = 0; i < 80; i++) {
      const res = await add('000000');
      if (res.status !== 429) continue;
      const wait = Number(res.headers.get('retry-after'));
      waits.push(wait);
      if (wait > 300) break;
      kit.clock.advance((wait + 1) * 1000);
    }
    const hourly = waits.at(-1) ?? 0;
    const person = waits[0] ?? 0;
    expect(person).toBeGreaterThan(0);
    expect(person).toBeLessThanOrEqual(300);
    expect(hourly).toBeGreaterThan(300);
    expect(hourly).toBeLessThanOrEqual(3600);
  });
});
