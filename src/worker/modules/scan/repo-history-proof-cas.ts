import type { SqlValue } from '../../platform/db.ts';
import { toHex } from '../../platform/ids.ts';
import { credentialRefKeysetSql } from '../passes/repo-credential-keyset.ts';
import { effectiveReleaseIdSql } from '../templates/repo-release-heads.ts';
import { issuedReleasePredicateSql, noScopedReleaseSql } from '../templates/repo-releases.ts';
import { validCredentialKeysetCommitment } from './repo-credential-tombstones.ts';
import { historyProofFields, PRIVATE_LABELS } from './repo-history-proof-fields.ts';
import {
  legacyScanProvenanceSql,
  recordedScanProvenanceSql,
  scanCurrentCredentialLineageSql,
  uniqueScanEventIdSql,
} from './repo-history-provenance.ts';
import type { ScanSecretBindLabel } from './repo-secret-binds.ts';
import { walletSnapshotPredicateSql } from './repo-wallet-snapshot.ts';

export type { VerifiedHistoryProof } from './history-proof.ts';

/** Serializable metadata only; private comparison values are held outside the snapshot. */
export interface HistoryProofSnapshot {
  readonly metadata: string;
}

/** Minimal, request-local CAS input retained after policy projection. */
export interface HistoryProofFence {
  scan: { id: string; eventId: string | null };
  projectionCurrent: boolean;
  credentialKeysetCommitment: string;
  snapshot: HistoryProofSnapshot;
}

type Scalar = string | number | null;
type CapturedValue = { value: Scalar; encoded: boolean };
const capturedValues = new WeakMap<
  HistoryProofSnapshot,
  {
    values: Record<string, CapturedValue>;
    credentialKeysetCommitment: string;
  }
>();
const encoder = new TextEncoder();
const BIND_TARGET = 750_000;
const FRAGMENT_SCALAR_BINDS = 8;
const MAX_METADATA_SEGMENTS = 48;
const SAFE_KEYS = [
  'org_id',
  'mode',
  'state',
  'outcome',
  'action_kind',
  'pass_version',
  'method',
  'at',
  'direction',
  'recorded_wallet_version',
  'current_pass_version',
  'current_pass_revision',
  'current_credential_generation',
  'current_lifecycle_generation',
  'current_image_generation',
  'current_link_generation',
  'current_connection_generation',
  'current_org_revision',
  'current_template_revision',
  'current_wallet_version',
  'current_identity_revision',
  'current_release_id',
  'current_release_generation',
  'current_release_hash',
  'ledger_org_id',
  'ledger_mode',
  'ledger_kind',
  'ledger_actor_type',
  'ledger_at',
  'approved_proof',
  'legacy_proof',
] as const;
const RAW_CREDENTIAL_KEYS: Record<string, true> = {
  pass_serial: true,
  pass_auth_token: true,
  pass_download_token: true,
  pass_web_service_url: true,
  pass_scan_code: true,
  pass_external_id: true,
  pass_holder_email: true,
};

function scalar(value: unknown): value is Scalar {
  return (
    value === null ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

/** Capture only explicitly classified columns; no raw private value enters the serialized snapshot. */
export function captureHistoryProofSnapshot(
  row: object,
  credentialKeysetCommitment: string,
): HistoryProofSnapshot | null {
  if (!validCredentialKeysetCommitment(credentialKeysetCommitment)) return null;
  const source = row as Record<string, unknown>;
  const metadata: Record<string, Scalar> = {};
  const values: Record<string, CapturedValue> = {};
  for (const key of SAFE_KEYS) {
    const value = source[key];
    if (!Object.hasOwn(source, key) || !scalar(value)) return null;
    metadata[key] = value;
  }
  for (const key of Object.keys(PRIVATE_LABELS)) {
    const value = source[key];
    if (!Object.hasOwn(source, key) || !scalar(value)) return null;
    // JSON-valued policy/Wallet fields can themselves contain credentials. Encode their exact
    // UTF-8 bytes as a labeled scalar rather than embedding them in any JSON bind.
    const encoded = typeof value === 'string' && !Object.hasOwn(RAW_CREDENTIAL_KEYS, key);
    values[key] = {
      value: encoded ? toHex(encoder.encode(value as string)).toUpperCase() : value,
      encoded,
    };
  }
  const snapshot = Object.freeze({ metadata: JSON.stringify(metadata) });
  capturedValues.set(snapshot, { values, credentialKeysetCommitment });
  return snapshot;
}

function utf8Size(value: string): number {
  let size = 0;
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code === undefined) throw new Error('Invalid UTF-8 character');
    size += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return size;
}

function jsonSegments(value: string): string[] {
  const segments: string[] = [];
  let start = 0;
  let bytes = 0;
  for (let index = 0; index < value.length; ) {
    const code = value.codePointAt(index);
    if (code === undefined) throw new Error('Invalid UTF-8 position');
    const size = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (bytes + size > BIND_TARGET) {
      segments.push(value.slice(start, index));
      start = index;
      bytes = 0;
    }
    bytes += size;
    index += code > 0xffff ? 2 : 1;
  }
  segments.push(value.slice(start));
  return segments;
}

/**
 * Every returned fragment must be checked against the same actor and keyset in one D1 transaction.
 * The scalar comparisons are split across fragments, never packed into the metadata JSON.
 */
export function historyProofSnapshotPredicates(
  proof: HistoryProofFence,
  scanAlias: string,
  now: number,
): { sql: string; params: SqlValue[] }[] {
  const denied = () => [{ sql: '0', params: [] }];
  if (
    !proof.projectionCurrent ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(scanAlias) ||
    !validCredentialKeysetCommitment(proof.credentialKeysetCommitment)
  )
    return denied();
  const captured = capturedValues.get(proof.snapshot);
  if (!captured || captured.credentialKeysetCommitment !== proof.credentialKeysetCommitment)
    return denied();
  const { values } = captured;
  const segments = jsonSegments(`[${proof.snapshot.metadata}]`);
  if (segments.length > MAX_METADATA_SEGMENTS) return denied();
  const credentialKeysetCommitment = proof.credentialKeysetCommitment;
  const pinned =
    "(CASE WHEN json_valid(hp_ledger.data) THEN json_extract(hp_ledger.data,'$.authority.pinnedTemplateVersion') END)";
  const scope = {
    templateIdSql: 'hp_pass.template_id',
    orgIdSql: 'hp_pass.org_id',
    modeSql: 'hp_pass.mode',
    providerSql: "'apple'",
  };
  const fields = historyProofFields(scanAlias, pinned);
  const safeComparisons: string[] = [];
  const scalars: { sql: string; value: SqlValue }[] = [];
  for (const [expression, key] of fields) {
    const label = (PRIVATE_LABELS as Record<string, ScanSecretBindLabel>)[key];
    if (!label) {
      safeComparisons.push(`${expression} IS json_extract(hp_snapshot.value,'$.${key}')`);
      continue;
    }
    const captured = values[key];
    if (!captured) return denied();
    const { value, encoded } = captured;
    if (value === null) {
      safeComparisons.push(`(${expression}) IS NULL`);
      continue;
    }
    const marker = `?/* scan-ephemeral-${label} */`;
    if (typeof value !== 'string') {
      scalars.push({ sql: `(${expression}) IS ${marker}`, value });
      continue;
    }
    if (encoded) {
      const hex = `hex(CAST((${expression}) AS BLOB))`;
      if (value.length <= BIND_TARGET) {
        scalars.push({ sql: `(typeof((${expression}))='text' AND ${hex} IS ${marker})`, value });
      } else {
        for (let at = 0; at < value.length; at += BIND_TARGET) {
          const part = value.slice(at, at + BIND_TARGET);
          scalars.push({
            sql: `(typeof((${expression}))='text' AND length(CAST((${expression}) AS BLOB))=${value.length / 2}
              AND substr(${hex},${at + 1},${part.length}) IS ${marker})`,
            value: part,
          });
        }
      }
      continue;
    }
    if (utf8Size(value) <= BIND_TARGET) {
      scalars.push({ sql: `(${expression}) IS ${marker}`, value });
      continue;
    }
    // Byte slices preserve embedded NULs and multibyte credentials without JSON packing.
    const bytes = encoder.encode(value);
    for (let at = 0; at < bytes.length; at += BIND_TARGET) {
      const part = bytes.subarray(at, at + BIND_TARGET);
      scalars.push({
        sql: `(typeof((${expression}))='text' AND length(CAST((${expression}) AS BLOB))=${bytes.length}
          AND substr(CAST((${expression}) AS BLOB),${at + 1},${part.length}) IS ${marker})`,
        value: part,
      });
    }
  }
  const approved = recordedScanProvenanceSql({
    scanAlias,
    ledgerAlias: 'hp_ledger',
    recordedTemplateVersionSql: pinned,
    walletVersionSql: 'hp_recorded.version',
    walletTemplateVersionSql: 'hp_recorded.template_version',
  });
  const legacy = legacyScanProvenanceSql({
    scanAlias,
    ledgerAlias: 'hp_ledger',
    recordedTemplateVersionSql: pinned,
    walletVersionSql: 'hp_recorded.version',
    walletTemplateVersionSql: 'hp_recorded.template_version',
  });
  const groups: (typeof scalars)[] = [];
  for (let at = 0; at < scalars.length; at += FRAGMENT_SCALAR_BINDS)
    groups.push(scalars.slice(at, at + FRAGMENT_SCALAR_BINDS));
  if (!groups.length) groups.push([]);
  return groups.map((group) => ({
    sql: `EXISTS (SELECT 1 FROM json_each(${segments.map(() => '?/* scan-ephemeral-history-snapshot */').join(' || ')}) hp_snapshot
      JOIN passes hp_pass ON hp_pass.id=${scanAlias}.pass_id AND hp_pass.org_id=${scanAlias}.org_id
        AND hp_pass.mode=${scanAlias}.mode AND hp_pass.template_id=${scanAlias}.template_id
      JOIN pass_events hp_ledger ON hp_ledger.id=${uniqueScanEventIdSql(scanAlias)}
      JOIN pass_versions hp_recorded ON hp_recorded.pass_id=${scanAlias}.pass_id
        AND hp_recorded.version=json_extract(hp_snapshot.value,'$.recorded_wallet_version')
      LEFT JOIN template_versions hp_event_pinned ON hp_event_pinned.template_id=${scanAlias}.template_id
        AND hp_event_pinned.version=${pinned}
      LEFT JOIN template_versions hp_event_wallet ON hp_event_wallet.template_id=${scanAlias}.template_id
        AND hp_event_wallet.version=hp_recorded.template_version
      LEFT JOIN template_versions hp_event_active ON hp_event_active.template_id=${scanAlias}.template_id
        AND hp_event_active.version=CASE WHEN json_valid(hp_ledger.data)
          THEN json_extract(hp_ledger.data,'$.authority.activeTemplateVersion') END
      LEFT JOIN template_releases hp_release ON hp_release.id=(${effectiveReleaseIdSql(scope)})
      LEFT JOIN template_versions hp_legacy ON hp_legacy.template_id=hp_pass.template_id
        AND hp_legacy.version=hp_pass.template_version AND hp_pass.release_id IS NULL
        AND hp_release.id IS NULL AND (${noScopedReleaseSql(scope)})
      LEFT JOIN template_versions hp_current_pinned ON hp_current_pinned.template_id=hp_pass.template_id
        AND hp_current_pinned.version=hp_pass.template_version
      LEFT JOIN template_versions hp_current_active ON hp_current_active.template_id=hp_pass.template_id
        AND hp_current_active.version=COALESCE(hp_release.version,hp_legacy.version)
      LEFT JOIN pass_versions hp_current_wallet ON hp_current_wallet.pass_id=hp_pass.id AND hp_current_wallet.version=(
        SELECT v.version FROM pass_versions v WHERE v.pass_id=hp_pass.id AND v.version<=hp_pass.version
        ORDER BY v.version DESC LIMIT 1)
      LEFT JOIN signing_identities hp_identity ON hp_identity.id=hp_pass.identity_id
        AND (hp_identity.org_id IS NULL OR hp_identity.org_id=hp_pass.org_id)
      LEFT JOIN connections hp_connection ON hp_connection.id=hp_pass.connection_id
        AND hp_connection.org_id=hp_pass.org_id AND hp_connection.enabled=1
      LEFT JOIN orgs hp_org ON hp_org.id=hp_pass.org_id
      LEFT JOIN templates hp_template ON hp_template.id=hp_pass.template_id
        AND (hp_template.org_id IS NULL OR hp_template.org_id=hp_pass.org_id)
      LEFT JOIN scanners hp_scanner ON hp_scanner.id=${scanAlias}.scanner_id
        AND hp_scanner.org_id=${scanAlias}.org_id AND hp_scanner.mode=${scanAlias}.mode
      WHERE ${[...safeComparisons, ...group.map((item) => item.sql)].join(' AND ')}
        AND ${scanAlias}.actor_type=hp_ledger.actor_type AND ${scanAlias}.actor_id=hp_ledger.actor_id
        AND hp_pass.status='active' AND hp_pass.deleted_at IS NULL AND hp_pass.removed_at IS NULL
        AND hp_pass.test_data_quarantined=0 AND hp_org.status='active' AND hp_template.status!='deleted'
        AND (hp_pass.connection_id IS NULL OR hp_connection.id IS NOT NULL)
        AND (${scanCurrentCredentialLineageSql('hp_pass', 'hp_ledger')})
        AND (hp_pass.release_id IS NULL OR (${issuedReleasePredicateSql(
          { releaseIdSql: 'hp_pass.release_id', versionSql: 'hp_pass.template_version' },
          scope,
        )}))
        AND (hp_release.id IS NOT NULL OR hp_legacy.version IS NOT NULL)
        AND ${walletSnapshotPredicateSql({ passAlias: 'hp_pass', nowSql: '?' })}
        AND ${credentialRefKeysetSql}
        AND ((json_extract(hp_snapshot.value,'$.approved_proof')=1 AND (${approved}))
          OR (json_extract(hp_snapshot.value,'$.legacy_proof')=1 AND (${legacy}))))`,
    params: [...segments, ...group.map((item) => item.value), now, credentialKeysetCommitment],
  }));
}
