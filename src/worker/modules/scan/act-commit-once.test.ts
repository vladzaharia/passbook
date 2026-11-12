import { beforeAll, describe, expect, it } from 'vitest';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { all, run } from '../../platform/db.ts';
import { beforeBatch } from './batch-interceptor-test-support.ts';
import { barcodeHashOfCode, cleanCode } from './codes.ts';
import { codeOf, key, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let tpl: string;
beforeAll(async () => {
  kit = await setupScanKit();
  tpl = await kit.scanTemplate('Commit once', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
});

type Pass = Awaited<ReturnType<ScanKit['scanPass']>>;
const scan = async (
  headers: Record<string, string>,
  input: { code: string; method: 'camera' },
  over: Record<string, unknown> = {},
) =>
  kit.post(headers, '/actions', {
    input,
    clientTs: kit.clock.now(),
    idempotencyKey: key(),
    actionId: 'check_in',
    ...over,
  });
const outcome = async (res: Response) => {
  expect(res.status).toBe(200);
  return (await res.json()) as ScanOutcome;
};
const COMMIT = /INSERT INTO scan_gates/;

describe('one heads-up is let through once', () => {
  async function headsUp() {
    const s = await kit.scanner({ templateIds: [tpl], settings: { letInAgain: 'anyone' } });
    const p = await kit.scanPass(tpl);
    expect((await outcome(await scan(s.headers, codeOf(p)))).kind).toBe('ok');
    const heads = await outcome(await scan(s.headers, codeOf(p)));
    expect(heads).toMatchObject({ kind: 'heads_up', reason: 'already_done', overridable: true });
    return { s, p, heads };
  }
  const overrides = (heads: ScanOutcome) =>
    all<{ id: string }>(kit.env.DB, "SELECT id FROM scans WHERE override_of=? AND outcome='ok'", [
      heads.scanId ?? '',
    ]);

  it('two overrides with different keys: the one that commits second is a heads-up', async () => {
    const { s, p, heads } = await headsUp();
    let rival: ScanOutcome | undefined;
    const { result, fired } = await beforeBatch(
      kit.env,
      COMMIT,
      async () => {
        rival = await outcome(await scan(s.headers, codeOf(p), { overrideOf: heads.scanId }));
      },
      () => scan(s.headers, codeOf(p), { overrideOf: heads.scanId }),
    );
    expect(fired).toBe(true);
    expect(rival?.kind).toBe('ok');
    expect(await outcome(result)).toMatchObject({
      kind: 'heads_up',
      reason: 'already_done',
      overridable: false,
      previous: { scanId: rival?.scanId },
    });
    expect((await overrides(heads)).map((o) => o.id)).toEqual([rival?.scanId]);
    const gate = await all<{ last_scan_id: string }>(
      kit.env.DB,
      'SELECT last_scan_id FROM scan_gates WHERE pass_id=?',
      [p.id],
    );
    expect(gate).toEqual([{ last_scan_id: rival?.scanId }]);
  });

  it('control: one override commits', async () => {
    const { s, p, heads } = await headsUp();
    const { result, fired } = await beforeBatch(
      kit.env,
      COMMIT,
      async (db) =>
        void (await run(db, 'UPDATE passes SET last_synced_at=? WHERE id=?', [1, p.id])),
      () => scan(s.headers, codeOf(p), { overrideOf: heads.scanId }),
    );
    expect(fired).toBe(true);
    const done = await outcome(result);
    expect(done.kind).toBe('ok');
    expect((await overrides(heads)).map((o) => o.id)).toEqual([done.scanId]);
  });
});

describe('the commit compares the credential the input matched', () => {
  /** A pass whose printed barcode is an outside member number, not its scan code. */
  async function barcodePass() {
    const p = await kit.scanPass(tpl);
    const input = { code: `MEMBER-CARD-${p.id.slice(-8)}`, method: 'camera' as const };
    await run(kit.env.DB, 'UPDATE passes SET barcode_hash=?,revision=revision+1 WHERE id=?', [
      await barcodeHashOfCode(cleanCode(input.code)),
      p.id,
    ]);
    return { p, input };
  }
  /** A publish rewrites the barcode hash in a new version, without a credential generation. */
  const rewrite = (p: Pass) => (db: D1Database) =>
    run(db, "UPDATE passes SET barcode_hash='rewritten-by-publish', version=version+1 WHERE id=?", [
      p.id,
    ]);
  const scanDuring = async (
    input: { code: string; method: 'camera' },
    change: (db: D1Database) => Promise<unknown>,
  ) => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const { result, fired } = await beforeBatch(
      kit.env,
      COMMIT,
      async (db) => void (await change(db)),
      () => scan(s.headers, input),
    );
    expect(fired).toBe(true);
    return result;
  };

  it('a barcode rewritten by a publish mid-request refuses a barcode scan', async () => {
    const { p, input } = await barcodePass();
    const res = await scanDuring(input, rewrite(p));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('SCAN_PASS_CHANGED');
    expect(
      await all(kit.env.DB, "SELECT id FROM scans WHERE pass_id=? AND outcome='ok'", [p.id]),
    ).toEqual([]);
  });

  it('control: the same barcode scan commits when nothing moved', async () => {
    const { input } = await barcodePass();
    const res = await scanDuring(input, async () => undefined);
    expect((await outcome(res)).kind).toBe('ok');
  });

  it('control: a scan-code scan is not refused by a rewritten barcode', async () => {
    const { p } = await barcodePass();
    const res = await scanDuring(codeOf(p), rewrite(p));
    expect((await outcome(res)).kind).toBe('ok');
  });
});
