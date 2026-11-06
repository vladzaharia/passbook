import { beforeAll, describe, expect, it } from 'vitest';
import { countD1 } from '../../../../test/helpers/index.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { putPassCheckIn } from '../passes/check-in.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { codeOf, key, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let template: string;
const bytes = makePng(270, 270);
const png = btoa(String.fromCharCode(...bytes));
beforeAll(async () => {
  kit = await setupScanKit();
  template = await kit.scanTemplate('Photo membership', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
});
const read = async (headers: Record<string, string>, code: ReturnType<typeof codeOf>) =>
  (await (
    await kit.post(headers, '/actions', {
      idempotencyKey: key(),
      input: code,
      actionId: 'auto',
      clientTs: kit.clock.now(),
    })
  ).json()) as ScanOutcome;

describe('scanner member photos', () => {
  it('keeps a policy-and-photo check-in within five round trips after the guard', async () => {
    const scanner = await kit.scanner({ templateIds: [template] });
    const warm = await kit.scanPass(template);
    await read(scanner.headers, codeOf(warm));
    const pass = await kit.scanPass(template);
    await putPassCheckIn(kit.ctx, { type: 'system', id: null }, pass.id, { mode: 'in_out' }, null);
    await putMemberPhoto(
      kit.ctx,
      { type: 'system', id: null },
      pass.id,
      { png, includeInPass: false },
      null,
    );
    const real = kit.env.DB;
    const counted = countD1(real);
    Object.assign(kit.env, { DB: counted.db });
    try {
      await kit.post(scanner.headers, '/actions', {});
      const guard = counted.count();
      counted.reset();
      expect((await read(scanner.headers, codeOf(pass))).kind).toBe('ok');
      expect(counted.count() - guard).toBeLessThanOrEqual(5);
    } finally {
      Object.assign(kit.env, { DB: real });
    }
  });
  it('renders a private photo and binds its image grant to the scanning device', async () => {
    const pass = await kit.scanPass(template);
    await putMemberPhoto(
      kit.ctx,
      { type: 'system', id: null },
      pass.id,
      { png, includeInPass: false },
      null,
    );
    const scanner = await kit.scanner({ templateIds: [template] });
    const other = await kit.scanner({ templateIds: [template] });
    const out = await read(scanner.headers, codeOf(pass));
    expect(out.kind).toBe('ok');
    const url = out.display?.identity.photo?.url;
    expect(url).toContain(`/passes/${pass.id}/assets/member.png?g=`);
    const path = (url ?? '').replace('/api/v1/scan', '');
    const image = await kit.get(scanner.headers, path);
    expect(image.status).toBe(200);
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(bytes);
    expect((await kit.get(other.headers, path)).status).toBe(404);
    expect((await kit.get({}, path)).status).toBe(401);
    kit.clock.advance(3_600_001);
    expect((await kit.get(scanner.headers, path)).status).toBe(404);
  });

  it('honors the scanner photo setting', async () => {
    const pass = await kit.scanPass(template);
    await putMemberPhoto(
      kit.ctx,
      { type: 'system', id: null },
      pass.id,
      { png, includeInPass: false },
      null,
    );
    const scanner = await kit.scanner({ templateIds: [template], settings: { showPhoto: false } });
    expect((await read(scanner.headers, codeOf(pass))).display?.identity.photo).toBeNull();
  });

  it('preserves a template photo role restriction', async () => {
    const restricted = await kit.scanTemplate('Desk photo', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
      display: { v: 1, photo: { minRole: 'desk' }, header: {} },
    });
    const pass = await kit.scanPass(restricted);
    await putMemberPhoto(
      kit.ctx,
      { type: 'system', id: null },
      pass.id,
      { png, includeInPass: false },
      null,
    );
    const scanner = await kit.scanner({ templateIds: [restricted] });
    expect((await read(scanner.headers, codeOf(pass))).display?.identity.photo).toBeNull();
  });
});
