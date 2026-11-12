import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeAll, describe, expect, it } from 'vitest';
import { countD1 } from '../../../../test/helpers/count-d1.ts';
import { fakeAuth, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { createApp } from '../../app.ts';
import type { AppBindings } from '../../platform/context.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { READ_PATH_WRITE_ALLOWLIST } from '../templates/repo-version-hashes.ts';
import { createScannerStore } from './auth-store.ts';
import {
  codeOf,
  DAY,
  grantScanMembership,
  key,
  ORIGIN,
  type ScanKit,
  setupScanKit,
} from './test-kit.ts';

/*
 * Reads never write (authority-epochs.md section 1.4). Every GET the scan module serves, as a
 * scanner and as a signed-in admin, runs against a statement log; the only writes that may appear
 * are the ones named here, and for a table that holds authority the columns are named too.
 */

/** Table -> the SET clause that may appear on a GET (no entry: any write to the table is refused). */
const ALLOWED_UPDATES: Record<string, RegExp> = {
  // session idle slide (auth/repo-sessions.ts)
  sessions: /^idle_expires_at\s*=/i,
  // scanner and staff last-use stamps
  scanners: /^(?:last_seen_at|last_ip_prefix|staff_seen_at)\s*=/i,
  // the event's expected-count cache, an idempotent fill (repo-counts.ts)
  scan_events: /^expected\s*=/i,
};
/**
 * Inserts a GET may make. Asset grants are minted on read until they become stateless HMAC tokens
 * (W3-02); the write-once version-hash row is the template package's allowlist.
 */
const ALLOWED_INSERTS = new Set<string>([
  ...READ_PATH_WRITE_ALLOWLIST,
  // the credential keyset singleton: `INSERT OR IGNORE`, written once on first use
  'credential_ref_keyset',
  // metrics counters (the export count), which hold no authority
  'counters',
  'scan_asset_grants',
  'scan_asset_grant_provenance',
]);

interface Write {
  kind: 'insert' | 'update' | 'delete';
  table: string;
  set: string;
}

/** The writes in a statement log. A statement that only mentions a write keyword is not one. */
function writesIn(statements: readonly string[]): Write[] {
  const writes: Write[] = [];
  for (const raw of statements) {
    const sql = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').trim();
    const m =
      /^(?:WITH\b[\s\S]*?\)\s*)?(INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+"?(\w+)"?(?:\s+AS\s+\w+)?(?:\s+SET\s+([\s\S]*?)(?:\bWHERE\b|$))?/i.exec(
        sql,
      );
    if (!m) continue;
    const verb = (m[1] ?? '').toLowerCase();
    writes.push({
      kind: verb.startsWith('update') ? 'update' : verb.startsWith('delete') ? 'delete' : 'insert',
      table: (m[2] ?? '').toLowerCase(),
      set: (m[3] ?? '').trim(),
    });
  }
  return writes;
}

function forbidden(writes: readonly Write[]): Write[] {
  return writes.filter((w) => {
    if (w.kind === 'insert') return !ALLOWED_INSERTS.has(w.table);
    if (w.kind === 'delete') return true;
    const allowed = ALLOWED_UPDATES[w.table];
    return !allowed?.test(w.set);
  });
}

describe('write detection', () => {
  it('finds writes, including a CTE-prefixed one, and ignores reads that mention them', () => {
    expect(
      writesIn([
        'SELECT 1 FROM scans WHERE note = "UPDATE passes SET x = 1"',
        'UPDATE passes AS p SET scan_code = ? WHERE p.id = ?',
        'WITH a AS (SELECT 1) INSERT INTO scan_asset_grants (x) SELECT 1',
        'DELETE FROM scan_gates WHERE id = ?',
      ]),
    ).toEqual([
      { kind: 'update', table: 'passes', set: 'scan_code = ?' },
      { kind: 'insert', table: 'scan_asset_grants', set: '' },
      { kind: 'delete', table: 'scan_gates', set: '' },
    ]);
    expect(forbidden(writesIn(['UPDATE scanners SET revoked_at = 1 WHERE id = ?']))).toHaveLength(
      1,
    );
    expect(forbidden(writesIn(['UPDATE scanners SET last_seen_at = ? WHERE id = ?']))).toEqual([]);
  });
});

let kit: ScanKit;
let app: OpenAPIHono<AppBindings>;
let admin: Record<string, string>;
let scannerHeaders: Record<string, string>;

beforeAll(async () => {
  kit = await setupScanKit();
  const fake = fakeAuth(ORIGIN);
  fake.bindApiKeys(kit.env, kit.clock);
  const user = await makeUser(kit.fx);
  await grantScanMembership(kit.fx, kit.org.id, user.id);
  admin = {
    ...(await makeSession(kit.fx, { userId: user.id, roles: ['admin', 'user'] })).headers,
    origin: ORIGIN,
  };
  app = createApp({
    stores: {
      ...fake.stores,
      sessions: createSessionStore(kit.env, kit.clock),
      scanners: createScannerStore(kit.env, kit.clock),
    },
    clock: kit.clock,
  });
  const templateId = await kit.scanTemplate('GET corpus', {
    actions: [{ id: 'check_in', label: 'Entry', kind: 'check_in', repeat: 'always' }],
  });
  const event = await kit.event({ templateIds: [templateId] });
  const scanner = await kit.scanner({ eventId: event.id });
  scannerHeaders = scanner.headers;
  const pass = await kit.scanPass(templateId, { memberName: 'Corpus Member' });
  for (let i = 0; i < 2; i++) {
    kit.clock.advance(1000);
    const response = await kit.post(scanner.headers, '/actions', {
      idempotencyKey: key(),
      input: codeOf(pass),
      clientTs: kit.clock.now(),
      actionId: 'check_in',
    });
    expect(((await response.json()) as ScanOutcome).kind).toBe('ok');
  }
});

/** Run every GET once through a statement log and return the writes it made. */
async function writesOf(requests: { path: string; headers: Record<string, string> }[]) {
  const counted = countD1(kit.env.DB);
  const real = kit.env.DB;
  Object.assign(kit.env, { DB: counted.db });
  try {
    for (const { path, headers } of requests) {
      counted.reset();
      const response = await app.request(`${ORIGIN}${path}`, { headers }, kit.env);
      expect(response.status, path).toBeLessThan(500);
      const writes = forbidden(writesIn(counted.sql()));
      expect(writes, `GET ${path}`).toEqual([]);
    }
  } finally {
    Object.assign(kit.env, { DB: real });
  }
}

describe('GET issues no writes outside the allowlist', () => {
  it('scanner reads: session, activity, scans, summary and stats', async () => {
    const from = kit.clock.now() - DAY;
    await writesOf(
      ['/session', '/activity', '/scans', '/summary', '/stats'].map((path) => ({
        path: `/api/v1/scan${path}${path === '/summary' ? `?from=${from}` : ''}`,
        headers: scannerHeaders,
      })),
    );
  });

  it('console reads: scans, export, events, scanners and setups', async () => {
    const range = `from=${kit.clock.now() - DAY}&to=${kit.clock.now() + DAY}`;
    await writesOf(
      [
        `/api/v1/scans?orgId=${kit.org.id}`,
        `/api/v1/scans/export?orgId=${kit.org.id}&${range}`,
        `/api/v1/scan-events?orgId=${kit.org.id}`,
        `/api/v1/scanners?orgId=${kit.org.id}`,
      ].map((path) => ({ path, headers: admin })),
    );
  });
});
