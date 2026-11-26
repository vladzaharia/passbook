import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { all, run } from '../../platform/db.ts';
import { packedEnvelopeColumns } from './packed-scan-test-fixtures.ts';
import { moveRows, selectEnvelopes } from './repo-rewrap.ts';
import { CAPTURE_TABLE, ENVELOPE_TABLES, PLACES } from './rewrap-tables.ts';

const db = (env as unknown as { DB: D1Database }).DB;
const FOUR = ['kek_version', 'iv', 'wrapped_dek', 'ciphertext'];

describe('the envelope registry', () => {
  it('lists every table with an envelope in its columns, and nothing else', async () => {
    const tables = await all<{ name: string }>(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
    );
    const found: string[] = [];
    for (const { name } of tables) {
      const columns = await all<{ name: string }>(db, `PRAGMA table_info("${name}")`);
      const names = new Set(columns.map((c) => c.name));
      const four = FOUR.map((c) => (name === 'wallet_provider_accounts' ? `hmac_${c}` : c));
      if (four.every((c) => names.has(c))) found.push(name);
    }
    // A new table with an envelope fails here until it has an entry (and an AAD) in rewrap-tables.ts.
    expect(found.sort()).toEqual(PLACES.map((p) => p.table).sort());
    expect(ENVELOPE_TABLES).toEqual([...PLACES.map((p) => p.table), CAPTURE_TABLE]);
  });

  it('has statements that compile on every table (a trigger or column that changed fails here)', async () => {
    const wrapped = new Uint8Array(60);
    for (const { table } of PLACES) {
      expect(await selectEnvelopes(db, table, null, 2, 1), table).toEqual([]);
      expect(
        await moveRows(db, {
          table,
          moves: [{ pk: 'none', kek: 1, wrapped, nextKek: 2, nextWrapped: wrapped }],
        }),
        table,
      ).toBe(0);
    }
    expect(
      await moveRows(db, {
        table: 'captured_emails',
        moves: [
          {
            pk: 'none',
            html: { from: 'enc1:1.a.b.', to: 'enc1:2.a.c.' },
            text: { from: '', to: '' },
          },
        ],
      }),
    ).toBe(0);
  });

  it('finds no packed envelope outside the registry, and the scan finds one that is there', async () => {
    expect(await packedEnvelopeColumns(db)).toEqual([]);
    await run(db, 'CREATE TABLE decoy_packed (a TEXT, b BLOB, c INTEGER)');
    try {
      await run(
        db,
        "INSERT INTO decoy_packed (a, b, c) VALUES ('plain', CAST('sc1.abc' AS BLOB), 1)",
      );
      expect(await packedEnvelopeColumns(db)).toEqual(['decoy_packed.b']);
      await run(db, "UPDATE decoy_packed SET a = 'enc1:2.x.y.z'");
      expect(await packedEnvelopeColumns(db)).toEqual(['decoy_packed.a', 'decoy_packed.b']);
    } finally {
      await run(db, 'DROP TABLE decoy_packed');
    }
  });
});

/** The calls that seal a value: where a token or secret becomes an envelope, and which places hold it. */
const NAMES = ['encryptSecret', 'sealBody', 'sealToken', 'issueToken', 'sealPart', 'sealStatement'];

/** Strips comments, then counts `name(` calls (a definition is not a call). */
function callSites(text: string): Record<string, number> {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const out: Record<string, number> = {};
  for (const name of NAMES) {
    const n = (
      code.match(new RegExp(`(?<!function\\s)(?<!async function\\s)\\b${name}\\(`, 'g')) ?? []
    ).length;
    if (n > 0) out[name] = n;
  }
  return out;
}

const SEALS = ['pass_token_seals', 'pass_auth_seals', 'bundle_token_seals', 'join_link_seals'];
// File (under src/worker) -> the call counts it may have, and the places those calls write. `ephemeral`
// envelopes are opened within a day or one call and never stored. A new call site, in a new file or a
// listed one, fails until it is counted here with its table.
const SITES: Record<string, { calls: Record<string, number>; tables: string[] | 'ephemeral' }> = {
  'platform/capability-token.ts': { calls: { encryptSecret: 1, sealToken: 1 }, tables: SEALS },
  'modules/apple/personalize.ts': {
    calls: { encryptSecret: 1 },
    tables: ['pass_personalizations'],
  },
  'modules/bundles/repo-writes.ts': { calls: { sealPart: 2 }, tables: ['bundle_token_seals'] },
  'modules/bundles/service.ts': { calls: { issueToken: 2 }, tables: ['bundle_token_seals'] },
  'modules/connections/legacy-duplicate.ts': {
    calls: { encryptSecret: 1 },
    tables: ['connection_webhook_retention'],
  },
  'modules/connections/legacy-inbox.ts': {
    calls: { encryptSecret: 1 },
    tables: ['connection_webhook_legacy_sources'],
  },
  'modules/connections/legacy-quarantine.ts': {
    calls: { encryptSecret: 2 },
    tables: ['connection_webhook_retention', 'connection_webhook_legacy_sources'],
  },
  'modules/connections/secrets.ts': { calls: { encryptSecret: 1 }, tables: ['credentials'] },
  'modules/connections/webhook-stage-helpers.ts': {
    calls: { encryptSecret: 1 },
    tables: ['connection_webhook_retention'],
  },
  'modules/join/links.ts': { calls: { issueToken: 2 }, tables: ['join_link_seals'] },
  'modules/join/repo-links.ts': { calls: { sealPart: 2 }, tables: ['join_link_seals'] },
  'modules/identities/pending-key.ts': { calls: { encryptSecret: 1 }, tables: ['credentials'] },
  'modules/identities/push-key-service.ts': { calls: { encryptSecret: 1 }, tables: ['apns_keys'] },
  'modules/identities/service.ts': { calls: { encryptSecret: 2 }, tables: ['credentials'] },
  'modules/nfc/keyset-seal.ts': {
    calls: { encryptSecret: 2 },
    tables: ['nfc_tag_keys', 'nfc_tag_sun'],
  },
  // The intended and admin keys are places; the session is ephemeral (a minute, never rewrapped).
  'modules/nfc/program-seal.ts': {
    calls: { encryptSecret: 3 },
    tables: ['nfc_tag_programs', 'nfc_tag_admin_keys'],
  },
  'modules/passes/create-records.ts': { calls: { sealPart: 2 }, tables: SEALS },
  'modules/passes/create-row.ts': { calls: { issueToken: 2 }, tables: SEALS },
  'modules/passes/credential-transfer.ts': {
    calls: { encryptSecret: 1, issueToken: 1 },
    tables: ['pass_credential_transfer_payloads', 'pass_token_seals'],
  },
  'modules/passes/pass-service-delivery.ts': { calls: { issueToken: 1 }, tables: SEALS },
  'modules/passes/repo-credential-transfer-finish.ts': {
    calls: { issueToken: 1, sealPart: 1 },
    tables: SEALS,
  },
  'modules/passes/repo-credential-transfer.ts': { calls: { sealPart: 1 }, tables: SEALS },
  'modules/passes/repo-pass-grants.ts': { calls: { sealPart: 1 }, tables: SEALS },
  'modules/passes/repo-pass-trusted.ts': { calls: { sealStatement: 1 }, tables: SEALS },
  'modules/sandbox/capture.ts': { calls: { sealBody: 2 }, tables: ['captured_emails'] },
  'modules/sandbox/captured-body.ts': { calls: { encryptSecret: 1 }, tables: ['captured_emails'] },
  'modules/scan/console-cursor.ts': { calls: { encryptSecret: 1 }, tables: 'ephemeral' },
  'modules/scan/live-attachment.ts': { calls: { encryptSecret: 1 }, tables: 'ephemeral' },
  'modules/status/checks-health.ts': { calls: { encryptSecret: 1 }, tables: 'ephemeral' },
  'modules/webhooks/secrets.ts': {
    calls: { encryptSecret: 1 },
    tables: ['webhook_endpoint_secrets'],
  },
  'modules/wallet-providers/credential-service.ts': {
    calls: { encryptSecret: 1 },
    tables: ['wallet_credential_versions'],
  },
  'modules/wallet-providers/credential-system-save.ts': {
    calls: { encryptSecret: 1 },
    tables: ['wallet_credential_versions'],
  },
  'modules/wallet-providers/credential-migrate.ts': {
    calls: { encryptSecret: 2 },
    tables: ['wallet_credential_versions', 'wallet_provider_accounts'],
  },
  'modules/wallet-providers/enrolment-source-key.ts': {
    calls: { encryptSecret: 1 },
    tables: ['wallet_provider_accounts'],
  },
  'modules/wallet-providers/account-service.ts': {
    calls: { encryptSecret: 1 },
    tables: ['wallet_provider_credentials'],
  },
  'modules/wallet-providers/callbacks-ref.ts': {
    calls: { encryptSecret: 1 },
    tables: ['wallet_samsung_fetch_refs'],
  },
  'modules/wallet-providers/callbacks-samsung-issued.ts': {
    calls: { encryptSecret: 1 },
    tables: ['wallet_samsung_callback_receipts'],
  },
  'modules/wallet-providers/callbacks-samsung-live.ts': {
    calls: { encryptSecret: 1 },
    tables: ['wallet_samsung_callback_receipts'],
  },
  'modules/wallet-providers/google-callback-handler.ts': {
    calls: { encryptSecret: 1 },
    tables: ['wallet_google_callback_receipts'],
  },
  'modules/wallet-providers/google-message-seal.ts': {
    calls: { encryptSecret: 1 },
    tables: ['wallet_google_messages'],
  },
  'modules/wallet-providers/instance-claims.ts': {
    calls: { encryptSecret: 2 },
    tables: ['wallet_provider_instance_outcomes'],
  },
};

/** What differs between the counted call sites and the expected ones, one line each. */
function siteDifferences(
  observed: Record<string, Record<string, number>>,
  expected: typeof SITES,
): string[] {
  const out: string[] = [];
  for (const file of new Set([...Object.keys(observed), ...Object.keys(expected)])) {
    const have = observed[file] ?? {};
    const want = expected[file]?.calls ?? {};
    for (const name of new Set([...Object.keys(have), ...Object.keys(want)]))
      if ((have[name] ?? 0) !== (want[name] ?? 0))
        out.push(`${file}: ${name} called ${have[name] ?? 0} times, expected ${want[name] ?? 0}`);
  }
  return out;
}

describe('every call that seals a value', () => {
  const sources = import.meta.glob(
    ['../../**/*.ts', '!../../**/*.test.ts', '!../../**/*fixtures.ts', '!../../**/test-kit.ts'],
    { query: '?raw', import: 'default', eager: true },
  ) as Record<string, string>;
  // Glob keys are relative to this directory: `../x` is modules/x, `../../x` is src/worker/x.
  const key = (file: string) =>
    file.startsWith('../../') ? file.slice(6) : `modules/${file.slice(3)}`;
  const observed: Record<string, Record<string, number>> = {};
  for (const [file, text] of Object.entries(sources)) {
    const calls = callSites(text);
    if (Object.keys(calls).length > 0 && !file.endsWith('platform/crypto.ts'))
      observed[key(file)] = calls;
  }
  const real = Object.fromEntries(Object.entries(observed));

  it('is counted per call site, not per file', () => {
    expect(Object.keys(observed).length).toBeGreaterThan(20);
    expect(siteDifferences(real, SITES)).toEqual([]);
  });

  it('fails for a new call in a file that is listed, and for one in a file that is not', () => {
    const file = 'modules/sandbox/captured-body.ts';
    const text = Object.entries(sources).find(([f]) => key(f) === file)?.[1] ?? '';
    const added = { ...real, [file]: callSites(`${text}\nawait encryptSecret(ring, 'x', 'y');`) };
    expect(siteDifferences(added, SITES)).toEqual([
      `${file}: encryptSecret called 2 times, expected 1`,
    ]);
    expect(siteDifferences({ ...real, 'modules/new/thing.ts': { sealBody: 1 } }, SITES)).toEqual([
      'modules/new/thing.ts: sealBody called 1 times, expected 0',
    ]);
    // A definition and a comment are not calls.
    expect(
      callSites('// encryptSecret(a)\nexport async function sealBody(a) {}\n/* issueToken(x) */'),
    ).toEqual({});
  });

  it('writes only places the job moves', () => {
    for (const [file, site] of Object.entries(SITES))
      if (site.tables !== 'ephemeral')
        for (const table of site.tables)
          expect(ENVELOPE_TABLES, `${file}: ${table}`).toContain(table);
  });
});
