import { issuedReleasePredicateSql } from '../templates/repo-releases.ts';

/** Return an event only when its scan linkage is unique in the exact pass scope. */
export function uniqueScanEventIdSql(scanAlias: string): string {
  return `(SELECT CASE WHEN count(*)=1 THEN min(e.id) END FROM pass_events e
    WHERE e.pass_id=${scanAlias}.pass_id AND e.org_id=${scanAlias}.org_id AND e.mode=${scanAlias}.mode
      AND (CASE WHEN json_valid(e.data) THEN json_extract(e.data,'$.scanId') END)=${scanAlias}.id)`;
}

/** Current Wallet scalar credentials for request-local privacy checks; never return its document. */
export function currentWalletPrivateValuesSql(walletAlias: string): string {
  const doc = `${walletAlias}.pass_json`;
  return `CASE WHEN json_valid(${doc}) THEN (
    SELECT json_group_array(CASE value.type WHEN 'true' THEN 'true' WHEN 'false' THEN 'false'
      ELSE CAST(value.atom AS TEXT) END)
    FROM json_tree(${doc}) value
    WHERE value.type IN ('text','integer','real','true','false') AND (
      value.fullkey IN ('$.serialNumber','$.authenticationToken','$.webServiceURL','$.barcode','$.barcodes','$.nfc','$.userInfo')
      OR value.fullkey LIKE '$.barcode.%' OR value.fullkey LIKE '$.barcodes[%'
      OR value.fullkey LIKE '$.nfc.%' OR value.fullkey LIKE '$.userInfo.%'
      OR value.fullkey LIKE '$.userInfo[%'
    )
  ) END`;
}

/** Current holder lineage for pass-sensitive projections, after the event MAC is verified. */
export function scanCurrentCredentialLineageSql(passAlias: string, ledgerAlias: string): string {
  const data = `${ledgerAlias}.data`;
  return `CASE WHEN json_valid(${data}) THEN
    json_type(${data},'$.authority.credentialGeneration')='integer'
    AND json_extract(${data},'$.authority.credentialGeneration')>0
    AND ${passAlias}.credential_generation=json_extract(${data},'$.authority.credentialGeneration')
    AND json_type(${data},'$.authority.noPendingTransfer')='true'
    AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers transfer
      WHERE transfer.pass_id=${passAlias}.id AND transfer.state='pending')
    ELSE 0 END`;
}

export interface RecordedScanProvenanceSql {
  /** Trusted aliases and expressions for the signed pass policy and exact recorded Wallet row. */
  scanAlias: string;
  ledgerAlias: string;
  recordedTemplateVersionSql: string;
  walletVersionSql: string;
  walletTemplateVersionSql: string;
}

/** SQL half of approved provenance; callers must also verify the event's keyed authority proof. */
export function recordedScanProvenanceSql(input: RecordedScanProvenanceSql): string {
  return scanProvenanceSql(input, false);
}

/** SQL half of the signed no-scoped-release sentinel, with the same scan and Wallet linkage. */
export function legacyScanProvenanceSql(input: RecordedScanProvenanceSql): string {
  return scanProvenanceSql(input, true);
}

function scanProvenanceSql(input: RecordedScanProvenanceSql, legacy: boolean): string {
  const s = input.scanAlias;
  const l = input.ledgerAlias;
  const data = `${l}.data`;
  const field = (name: string) => `json_extract(${data},'$.authority.${name}')`;
  const type = (name: string) => `json_type(${data},'$.authority.${name}')`;
  const scope = {
    templateIdSql: `${s}.template_id`,
    orgIdSql: `${s}.org_id`,
    modeSql: `${s}.mode`,
    providerSql: "'apple'",
  };
  const active = issuedReleasePredicateSql(
    {
      releaseIdSql: field('activeReleaseId'),
      generationSql: field('activeReleaseGeneration'),
      versionSql: field('activeReleaseVersion'),
      candidateHashSql: field('activeReleaseCandidateHash'),
    },
    scope,
  );
  const pinned = issuedReleasePredicateSql(
    {
      releaseIdSql: field('pinnedReleaseId'),
      versionSql: input.recordedTemplateVersionSql,
    },
    scope,
  );
  return `CASE WHEN json_valid(${data}) THEN ${l}.org_id=${s}.org_id AND ${l}.mode=${s}.mode AND ${l}.pass_id=${s}.pass_id
    AND ${l}.actor_type=${s}.actor_type AND ${l}.actor_id=${s}.actor_id
    AND ${l}.kind=CASE WHEN ${s}.outcome='ok' AND ${s}.direction='out' THEN 'scan.checked_out'
      WHEN ${s}.outcome='ok' THEN 'scan.checked_in' WHEN ${s}.outcome='heads_up' THEN 'scan.heads_up'
      WHEN ${s}.outcome='refused' THEN 'scan.rejected' END
    AND json_extract(${data},'$.scanId')=${s}.id
    AND json_extract(${data},'$.scannerId') IS ${s}.scanner_id
    AND json_extract(${data},'$.staffId') IS ${s}.staff_id
    AND json_extract(${data},'$.eventId') IS ${s}.event_id
    AND json_extract(${data},'$.method')=${s}.method
    AND json_extract(${data},'$.outcome')=${s}.outcome
    AND json_extract(${data},'$.reason') IS ${s}.reason
    AND ((${s}.action_id IS NULL AND json_type(${data},'$.actionIdRef')='null')
      OR (${s}.action_id IS NOT NULL AND json_type(${data},'$.actionIdRef')='text'
        AND length(json_extract(${data},'$.actionIdRef'))=64))
    AND json_extract(${data},'$.actionKind') IS ${s}.action_kind
    AND json_type(${data},'$.version')='integer' AND json_extract(${data},'$.version')=${s}.pass_version
    AND ${input.recordedTemplateVersionSql} IS NOT NULL
    AND ${type('templateId')}='text' AND ${field('templateId')}=${s}.template_id
    AND ${type('pinnedTemplateVersion')}='text' AND ${field('pinnedTemplateVersion')}=${input.recordedTemplateVersionSql}
    AND ${type('walletVersion')}='integer' AND ${field('walletVersion')}>0
    AND ${field('walletVersion')}<=${s}.pass_version AND ${field('walletVersion')}=${input.walletVersionSql}
    AND ${type('walletTemplateVersion')} IN ('null','text')
    AND ${field('walletTemplateVersion')} IS ${input.walletTemplateVersionSql}
    AND ${type('scanAt')}='integer' AND ${field('scanAt')}=${s}.at
    AND ${type('nonQuarantined')}='true'
    AND ${type('passJsonHash')}='text' AND ${type('identityRevision')}='integer'
    AND ${type('credentialGeneration')}='integer' AND ${field('credentialGeneration')}>0
    AND ${type('noPendingTransfer')}='true'
    AND ${type('lifecycleGeneration')}='integer' AND ${field('lifecycleGeneration')}>=0
    ${
      legacy
        ? `AND ${type('pinnedReleaseId')}='null'
      AND ${type('activeReleaseId')}='null' AND ${type('activeReleaseGeneration')}='null'
      AND ${type('activeReleaseVersion')}='null' AND ${type('activeReleaseCandidateHash')}='null'
      AND ${type('activeTemplateVersion')}='text'
      AND ${field('activeTemplateVersion')}=${input.recordedTemplateVersionSql}`
        : `AND ${type('activeReleaseId')}='text' AND ${type('activeReleaseGeneration')}='integer'
      AND ${type('activeReleaseVersion')}='text' AND ${type('activeReleaseCandidateHash')}='text'
      AND (${active})
      AND (${type('pinnedReleaseId')}='null' OR (${type('pinnedReleaseId')}='text' AND (${pinned})))`
    }
    ELSE 0 END`;
}
