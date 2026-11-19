// Shared by the 0114 schema tests: a node:sqlite database migrated up to a point, and rows for the provider
// instances and every table that hangs off them. Foreign keys are enforced; triggers are off while seeding.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const migrations = resolve(import.meta.dirname, '../migrations');
const names = readdirSync(migrations)
  .filter((n) => n.endsWith('.sql'))
  .sort();

export const read = (name: string) => readFileSync(resolve(migrations, name), 'utf8');
export const migrationFile = (prefix: string) => names.find((n) => n.startsWith(prefix)) as string;

export function migratedBefore(prefix: string, foreignKeys = true): DatabaseSync {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: foreignKeys });
  for (const name of names.filter((n) => n < prefix)) db.exec(read(name));
  return db;
}

export type Master = { type: string; name: string; tbl_name: string; sql: string | null };
export const dump = (db: DatabaseSync) =>
  (
    db
      .prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name')
      .all() as Master[]
  ).map((r) => `${r.type}|${r.name}|${r.tbl_name}|${r.sql}`);

/** Run `fn` with every trigger dropped, then recreate them in their original order. */
export function withoutTriggers(db: DatabaseSync, fn: () => void) {
  const triggers = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' ORDER BY rowid")
    .all() as { sql: string }[];
  for (const { name } of db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
    .all() as { name: string }[])
    db.exec(`DROP TRIGGER "${name}"`);
  try {
    fn();
  } finally {
    for (const { sql } of triggers) db.exec(sql);
  }
}

export const H = (c: string) => c.repeat(64);
const blob = "x'00', x'00', x'00'";

/** The 12 tables of the instance closure, in creation order. */
export const CLOSURE = [
  'wallet_provider_instances',
  'wallet_provider_instance_operations',
  'wallet_provider_offer_refs',
  'wallet_provider_callback_events',
  'wallet_provider_instance_outcomes',
  'wallet_provider_instance_dirty',
  'wallet_samsung_fetch_refs',
  'wallet_samsung_callback_receipts',
  'wallet_samsung_country_hints',
  'wallet_provider_sync_targets',
  'wallet_google_callback_bindings',
  'wallet_google_callback_receipts',
];

/** Parents the instances need: orgs, a pass on a template version, two enrolments, one release. */
export function seedParents(db: DatabaseSync, org = 'o1', pass = 'p1') {
  const w = (sql: string) => db.exec(sql);
  w(
    `INSERT INTO orgs (id, slug, name, status, created_at, updated_at) VALUES ('${org}', '${org}', 'O', 'active', 1, 1)`,
  );
  w(
    `INSERT INTO signing_identities (id, org_id, label, pass_type_identifier, team_identifier, source, env_prefix, created_at) VALUES ('sid-${org}', '${org}', 'L', 'pass.${org}', 'T', 'env', 'X', 1)`,
  );
  w(
    `INSERT INTO templates (id, org_id, slug, name, origin, created_at, updated_at) VALUES ('t-${org}', '${org}', 't', 'T', 'uploaded', 1, 1)`,
  );
  w(
    `INSERT INTO template_versions (template_id, version, manifest, pass_json, created_at) VALUES ('t-${org}', 'v1', '{}', '{}', 1)`,
  );
  w(
    `INSERT INTO passes (id, org_id, identity_id, serial, template_id, template_version, auth_token, download_token, web_service_url, object_key, modified_at, created_at) VALUES ('${pass}', '${org}', 'sid-${org}', 's-${pass}', 't-${org}', 'v1', 'a', 'd-${pass}', 'https://x.test', 'k-${pass}', 1, 1)`,
  );
  for (const [provider, id] of [
    ['google', `ag-${org}`],
    ['samsung', `as-${org}`],
  ])
    w(
      `INSERT INTO wallet_provider_accounts (id, org_id, mode, provider, created_at, updated_at) VALUES ('${id}', '${org}', 'live', '${provider}', 1, 1)`,
    );
  w(
    `INSERT INTO template_releases (id, template_id, org_id, mode, provider, generation, version, candidate_hash, content_hash, adapter_revision, adapter_capabilities, audience_policy_revision, source, action, created_at) VALUES ('r-${org}', 't-${org}', '${org}', 'live', 'google', 1, 'v1', '${H('a')}', '${H('b')}', 1, '[]', 1, 'system', 'system', 1)`,
  );
}

/** One active Google and one active Samsung instance with a row in every child table. */
export function seedInstances(db: DatabaseSync, org = 'o1', pass = 'p1') {
  const w = (sql: string) => db.exec(sql);
  for (const [i, provider, acc] of [
    [`ig-${org}`, 'google', `ag-${org}`],
    [`is-${org}`, 'samsung', `as-${org}`],
  ]) {
    w(
      `INSERT INTO wallet_provider_instances (id, pass_id, org_id, mode, provider, account_id, identity_projection_release_id, credential_generation, lifecycle, desired_version, desired_operation_id, created_at, updated_at) VALUES ('${i}', '${pass}', '${org}', 'live', '${provider}', '${acc}', 'r-${org}', 1, 'active', 1, 'op-${i}', 1, 1)`,
    );
    w(
      `INSERT INTO wallet_provider_instance_operations (id, instance_id, version, kind, request_hash, pass_version, pass_revision, pass_credential_generation, lifecycle_generation, issuing_release_id, projection_release_id, account_revision, adapter_revision, policy_revision, state, created_at) VALUES ('op-${i}', '${i}', 1, 'upsert', '${H('c')}', 1, 0, 1, 0, 'r-${org}', 'r-${org}', 1, 1, 1, 'succeeded', 1)`,
    );
    w(
      `INSERT INTO wallet_provider_offer_refs (ref_hash, instance_id, operation_version, created_at, expires_at) VALUES ('${H(provider === 'google' ? 'd' : 'e').slice(1)}${org.slice(-1)}', '${i}', 1, 1, 2)`,
    );
    w(
      `INSERT INTO wallet_provider_callback_events (account_id, event_id_hash, payload_hash, instance_id, operation_version, kind, observed_at, received_at) VALUES ('${acc}', '${H('f')}', '${H('0')}', '${i}', 1, 'installed', 1, 1)`,
    );
    w(
      `INSERT INTO wallet_provider_instance_outcomes (id, operation_id, attempt, sequence, event_hash, payload_hash, kek_version, iv, wrapped_dek, ciphertext, received_at) VALUES ('oc-${i}', 'op-${i}', 1, 1, '${H('1')}', '${H('2')}', 1, x'00', x'00', x'00', 1)`,
    );
    w(`INSERT INTO wallet_provider_instance_dirty (instance_id, generation) VALUES ('${i}', 1)`);
    w(
      `INSERT INTO wallet_provider_sync_targets (operation_id, country_code, updated_at) VALUES ('op-${i}', 'US', 1)`,
    );
  }
  const i = `is-${org}`;
  w(
    `INSERT INTO wallet_samsung_fetch_refs (id, ref_hash, instance_id, created_at, last_offered_at, initial_expires_at, kek_version, iv, wrapped_dek, ciphertext) VALUES ('fr-${org}', '${H('3').slice(1)}${org.slice(-1)}', '${i}', 1, 1, 2, 1, x'00', x'00', x'00')`,
  );
  w(
    `INSERT INTO wallet_samsung_callback_receipts (id, ref_id, instance_id, account_id, org_id, mode, operation_version, kind, signed_at, received_at, kek_version, iv, wrapped_dek, ciphertext) VALUES ('sr-${org}', 'fr-${org}', '${i}', 'as-${org}', '${org}', 'live', 1, 'state_callback', 1, 1, 1, ${blob})`,
  );
  w(
    `INSERT INTO wallet_samsung_country_hints (ref_id, country_code, received_at) VALUES ('fr-${org}', 'US', 1)`,
  );
  const g = `ig-${org}`;
  w(
    `INSERT INTO wallet_google_callback_bindings (instance_id, account_id, class_id_hash, object_id_hash, created_at) VALUES ('${g}', 'ag-${org}', '${H('4')}', '${H('5')}', 1)`,
  );
  w(
    `INSERT INTO wallet_google_callback_receipts (id, instance_id, account_id, org_id, mode, event_type, nonce_hash, expires_at, received_at, kek_version, iv, wrapped_dek, ciphertext) VALUES ('gr-${org}', '${g}', 'ag-${org}', '${org}', 'live', 'save', '${H('6')}', 2, 1, 1, ${blob})`,
  );
}

/** Everything migrated through 0114, with two orgs seeded (o1/p1, o2/p2) and the credential keyset set. */
export function epochWorld(): DatabaseSync {
  const db = migratedBefore('0115');
  withoutTriggers(db, () => {
    for (const [org, pass] of [
      ['o1', 'p1'],
      ['o2', 'p2'],
    ] as const) {
      seedParents(db, org, pass);
      seedInstances(db, org, pass);
    }
    db.exec(`INSERT INTO credential_ref_keyset (id, commitment) VALUES (1, '${H('7')}')`);
  });
  return db;
}

/** Run `fn` inside a savepoint that is always rolled back, so tests share one seeded database. */
export function rolledBack(db: DatabaseSync, fn: () => void) {
  db.exec('SAVEPOINT t');
  try {
    fn();
  } finally {
    db.exec('ROLLBACK TO t');
    db.exec('RELEASE t');
  }
}

/** Google instance of p1 retired by channel_off and settled: revoked, its revoke succeeded, nothing in flight. */
export function settleGooglePredecessor(db: DatabaseSync) {
  db.exec(
    "INSERT INTO pass_channels (pass_id, org_id, mode, template_id, channel, retired_at, retired_cause, set_by, set_at) VALUES ('p1', 'o1', 'live', 't-o1', 'google', 5, 'template', 'u', 5)",
  );
  db.exec(
    "UPDATE wallet_provider_instances SET retirement_requested_at = 5, retirement_cause = 'channel_off', lifecycle = 'revoking' WHERE id = 'ig-o1'",
  );
  withoutTriggers(db, () =>
    db.exec(
      `INSERT INTO wallet_provider_instance_operations (id, instance_id, version, kind, request_hash, pass_version, pass_revision, pass_credential_generation, lifecycle_generation, issuing_release_id, projection_release_id, account_revision, adapter_revision, policy_revision, state, created_at) VALUES ('op-rev', 'ig-o1', 2, 'revoke', '${H('8')}', 1, 0, 1, 0, 'r-o1', 'r-o1', 1, 1, 1, 'succeeded', 6)`,
    ),
  );
  db.exec(
    "UPDATE wallet_provider_instances SET desired_operation_id = 'op-rev', desired_version = 2, lifecycle = 'revoked' WHERE id = 'ig-o1'",
  );
  db.exec(
    "UPDATE pass_channels SET retired_at = NULL, retired_cause = NULL WHERE pass_id = 'p1' AND channel = 'google'",
  );
}

/** A valid epoch 2 Google successor row of p1; `over` replaces columns. */
export function successorSql(over: Record<string, string> = {}): string {
  const v: Record<string, string> = {
    id: "'ig2-o1'",
    pass_id: "'p1'",
    org_id: "'o1'",
    mode: "'live'",
    provider: "'google'",
    account_id: "'ag-o1'",
    identity_projection_release_id: "'r-o1'",
    credential_generation: '1',
    channel_epoch: '2',
    lifecycle: "'active'",
    desired_version: '1',
    desired_operation_id: "'op-ig2'",
    credential_keyset_commitment: `'${H('7')}'`,
    created_at: '7',
    updated_at: '7',
    ...over,
  };
  return `INSERT INTO wallet_provider_instances (${Object.keys(v).join(', ')}) VALUES (${Object.values(v).join(', ')})`;
}
