import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { all } from '../../platform/db.ts';
import { moveCaptures, moveEnvelopes, type PlaceTable, selectEnvelopes } from './repo-rewrap.ts';
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
      if (FOUR.every((c) => names.has(c))) found.push(name);
    }
    // A new table with an envelope fails here until it has an entry (and an AAD) in rewrap-tables.ts.
    expect(found.sort()).toEqual(PLACES.map((p) => p.table).sort());
    expect(ENVELOPE_TABLES).toEqual([...PLACES.map((p) => p.table), CAPTURE_TABLE]);
  });

  it('has statements that compile on every table (a trigger or column that changed fails here)', async () => {
    const wrapped = new Uint8Array(60);
    for (const { table } of PLACES) {
      expect(await selectEnvelopes(db, table as PlaceTable, null, 2, 1), table).toEqual([]);
      expect(
        await moveEnvelopes(db, table, [
          { pk: 'none', kek: 1, wrapped, nextKek: 2, nextWrapped: wrapped },
        ]),
        table,
      ).toBe(0);
    }
    expect(
      await moveCaptures(db, [
        {
          pk: 'none',
          html: { from: 'enc1:1.a.b.', to: 'enc1:2.a.c.' },
          text: { from: '', to: '' },
        },
      ]),
    ).toBe(0);
  });
});

// Every call of encryptSecret outside tests, by file: the places it writes, or that it is short-lived.
const WRITERS: Record<string, string[] | 'ephemeral'> = {
  '../../platform/capability-token.ts': [
    'pass_token_seals',
    'pass_auth_seals',
    'bundle_token_seals',
  ],
  '../apple/personalize.ts': ['pass_personalizations'],
  '../wallet-providers/google-callback-handler.ts': ['wallet_google_callback_receipts'],
  '../wallet-providers/callbacks-samsung.ts': ['wallet_samsung_callback_receipts'],
  '../wallet-providers/instance-claims.ts': ['wallet_provider_instance_outcomes'],
  '../wallet-providers/callbacks-ref.ts': ['wallet_samsung_fetch_refs'],
  '../wallet-providers/account-service.ts': ['wallet_provider_credentials'],
  '../passes/credential-transfer.ts': ['pass_credential_transfer_payloads'],
  '../connections/webhook-stage-helpers.ts': ['connection_webhook_retention'],
  '../connections/legacy-duplicate.ts': ['connection_webhook_retention'],
  '../connections/legacy-quarantine.ts': [
    'connection_webhook_retention',
    'connection_webhook_legacy_sources',
  ],
  '../connections/legacy-inbox.ts': ['connection_webhook_legacy_sources'],
  '../connections/secrets.ts': ['credentials'],
  '../identities/service.ts': ['credentials'],
  '../identities/push-key-service.ts': ['apns_keys'],
  '../sandbox/captured-body.ts': ['captured_emails'],
  // Sealed and opened within a day, or in one call; not stored.
  '../scan/console-cursor.ts': 'ephemeral',
  '../scan/live-attachment.ts': 'ephemeral',
  '../status/checks-health.ts': 'ephemeral',
};

describe('every writer of an envelope', () => {
  const sources = import.meta.glob(
    ['../../**/*.ts', '!../../**/*.test.ts', '!../../**/*fixtures.ts', '!../../**/test-kit.ts'],
    { query: '?raw', import: 'default', eager: true },
  ) as Record<string, string>;
  const writers = Object.entries(sources)
    .filter(
      ([file, text]) => /\bencryptSecret\(/.test(text) && !file.endsWith('platform/crypto.ts'),
    )
    .map(([file]) => file);

  it('is known: a new call site fails until it is registered or marked short-lived', () => {
    expect(writers.length).toBeGreaterThan(10);
    const unknown = writers.filter((file) => !(file in WRITERS));
    expect(unknown).toEqual([]);
    const gone = Object.keys(WRITERS).filter((file) => !writers.includes(file));
    expect(gone).toEqual([]);
  });

  it('writes only tables the job moves', () => {
    for (const [file, tables] of Object.entries(WRITERS))
      if (tables !== 'ephemeral')
        for (const table of tables) expect(ENVELOPE_TABLES, `${file}: ${table}`).toContain(table);
  });
});
