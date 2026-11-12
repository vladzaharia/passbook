import { beforeAll, describe, expect, it } from 'vitest';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { first, run } from '../../platform/db.ts';
import { beforeBatch } from './batch-interceptor-test-support.ts';
import { codeOf, key, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let tpl: string;
beforeAll(async () => {
  kit = await setupScanKit();
  tpl = await kit.scanTemplate('Stale refusals', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', repeat: 'always' }],
  });
});

type Pass = Awaited<ReturnType<ScanKit['scanPass']>>;
const body = (p: Pass, idempotencyKey = key()) => ({
  input: codeOf(p),
  clientTs: kit.clock.now(),
  idempotencyKey,
  actionId: 'check_in',
});
const problem = async (res: Response) => ({
  status: res.status,
  code: ((await res.clone().json()) as { code?: string }).code ?? null,
});

/** Statements that open each phase of `POST /actions`. */
const AT = {
  /** The first batch: replay lookup and the actor fences, before the claim. */
  start: /SELECT \* FROM scans WHERE actor_key=/,
  /** The admission and preflight reads, after the claim. */
  preflight: /LEFT JOIN scans h ON h\.id=g\.last_scan_id/,
  /** The commit grant. */
  commit: /INSERT INTO scan_gates/,
} as const;

async function scanWhile(
  at: RegExp,
  change: (db: D1Database) => Promise<unknown>,
  headers: Record<string, string>,
  p: Pass,
  idempotencyKey = key(),
) {
  const { result, fired } = await beforeBatch(
    kit.env,
    at,
    async (db) => void (await change(db)),
    () => kit.post(headers, '/actions', body(p, idempotencyKey)),
  );
  expect(fired).toBe(true);
  return result;
}

/** A credential write must advance the scanner's revision, as the service's writes do. */
const setScanner =
  (id: string, set: string, ...params: (string | number)[]) =>
  (db: D1Database) =>
    run(db, `UPDATE scanners SET ${set}, updated_at = updated_at + 1 WHERE id = ?`, [
      ...params,
      id,
    ]);

describe('authority lost between the reads and the commit is never a miss', () => {
  it('a scanner configuration change answers 409 SCAN_CONFIG_CHANGED', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const p = await kit.scanPass(tpl);
    const change = setScanner(s.id, "settings = json_set(settings,'$.lookup',json('false'))");
    const res = await scanWhile(AT.start, change, s.headers, p);
    expect(await problem(res)).toEqual({ status: 409, code: 'SCAN_CONFIG_CHANGED' });
  });

  it('a staff change answers 409 SCAN_STAFF_CHANGED', async () => {
    const s = await kit.scanner({ templateIds: [tpl], settings: { staffSignIn: true } });
    const person = await kit.staff('door', 'Dana');
    const bound = await kit.post(s.headers, '/staff', { staffId: person.id, pin: person.pin });
    expect(bound.status).toBe(200);
    const p = await kit.scanPass(tpl);
    const change = (db: D1Database) =>
      run(db, "UPDATE scan_staff SET pin_hash = 'moved' WHERE id = ?", [person.id]);
    const res = await scanWhile(AT.start, change, s.headers, p);
    expect(await problem(res)).toEqual({ status: 409, code: 'SCAN_STAFF_CHANGED' });
  });

  it('a pass that moved under a current actor answers 409 SCAN_IN_PROGRESS; the retry is truthful', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const p = await kit.scanPass(tpl);
    const idempotencyKey = key();
    const voidIt = (db: D1Database) =>
      run(db, "UPDATE passes SET status = 'voided' WHERE id = ?", [p.id]);
    const res = await scanWhile(AT.preflight, voidIt, s.headers, p, idempotencyKey);
    expect(await problem(res)).toEqual({ status: 409, code: 'SCAN_IN_PROGRESS' });
    expect(res.headers.get('retry-after')).toBe('1');
    const retry = await kit.post(s.headers, '/actions', body(p, idempotencyKey));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ kind: 'refused', reason: 'voided' });
  });

  it.each([
    ['start', AT.start],
    ['preflight', AT.preflight],
    ['commit', AT.commit],
  ])('control: an unrelated change at the %s commits the scan', async (_at, at) => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const other = await kit.scanner({ templateIds: [tpl] });
    const p = await kit.scanPass(tpl);
    const change = setScanner(other.id, "settings = json_set(settings,'$.lookup',json('false'))");
    const res = await scanWhile(at, change, s.headers, p);
    expect(res.status).toBe(200);
    expect(((await res.json()) as ScanOutcome).kind).toBe('ok');
  });
});

describe('only a lost credential unpairs a scanner mid-request', () => {
  const pairCode = (id: string) =>
    setScanner(
      id,
      'pair_code_hash = ?, pair_expires_at = ?',
      `issued-${id}`,
      kit.clock.now() + 60_000,
    );

  it.each([
    ['start', AT.start],
    ['commit', AT.commit],
  ])('a pair code issued at the %s answers 409 and keeps the device paired', async (_at, at) => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const p = await kit.scanPass(tpl);
    const before = await first<{ credential_epoch: number }>(
      kit.env.DB,
      'SELECT credential_epoch FROM scanners WHERE id = ?',
      [s.id],
    );
    const idempotencyKey = key();
    const res = await scanWhile(at, pairCode(s.id), s.headers, p, idempotencyKey);
    expect(await problem(res)).toEqual({ status: 409, code: 'SCAN_CONFIG_CHANGED' });
    const after = await first<{ credential_epoch: number }>(
      kit.env.DB,
      'SELECT credential_epoch FROM scanners WHERE id = ?',
      [s.id],
    );
    expect(after?.credential_epoch).toBeGreaterThan(before?.credential_epoch ?? 0);
    // The client refetches and sends the same key again: the scan commits.
    const retry = await kit.post(s.headers, '/actions', body(p, idempotencyKey));
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as ScanOutcome).kind).toBe('ok');
  });

  it('a mode move at the commit answers 409, not a re-pair', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const p = await kit.scanPass(tpl);
    const res = await scanWhile(AT.commit, setScanner(s.id, "mode = 'test'"), s.headers, p);
    expect(await problem(res)).toEqual({ status: 409, code: 'SCAN_CONFIG_CHANGED' });
  });

  it.each([
    ['token replaced', "token_hash = 'other'"],
    ['CSRF secret rotated', "csrf_secret = 'rotated'"],
    ['revoked', 'revoked_at = 1'],
  ])('%s at the commit answers 401 SCANNER_REPAIR', async (_name, set) => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const p = await kit.scanPass(tpl);
    const res = await scanWhile(AT.commit, setScanner(s.id, set), s.headers, p);
    expect(await problem(res)).toEqual({ status: 401, code: 'SCANNER_REPAIR' });
  });

  it('an undo while a pair code is issued answers 409 and the retry undoes', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const p = await kit.scanPass(tpl);
    const done = (await (await kit.post(s.headers, '/actions', body(p))).json()) as ScanOutcome;
    expect(done.kind).toBe('ok');
    const undo = () => kit.post(s.headers, `/scans/${done.scanId}/undo`, { idempotencyKey: key() });
    const { result, fired } = await beforeBatch(
      kit.env,
      /UPDATE scans SET undone_by/,
      async (db) => void (await pairCode(s.id)(db)),
      undo,
    );
    expect(fired).toBe(true);
    expect(await problem(result)).toEqual({ status: 409, code: 'SCAN_CONFIG_CHANGED' });
    expect((await undo()).status).toBe(200);
  });
});
