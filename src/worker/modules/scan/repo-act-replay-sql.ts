import { issuedReleasePredicateSql } from '../templates/repo-releases.ts';
import { recordedScanProvenanceSql } from './repo-history-provenance.ts';

export const RECORDED_PROOF = recordedScanProvenanceSql({
  scanAlias: 'q',
  ledgerAlias: 'l',
  recordedTemplateVersionSql: "json_extract(l.data,'$.authority.pinnedTemplateVersion')",
  walletVersionSql: "json_extract(l.data,'$.authority.walletVersion')",
  walletTemplateVersionSql: "json_extract(l.data,'$.authority.walletTemplateVersion')",
});
export const CURRENT_ISSUANCE = issuedReleasePredicateSql(
  { releaseIdSql: 'p.release_id', versionSql: 'p.template_version' },
  {
    templateIdSql: 'p.template_id',
    orgIdSql: 'p.org_id',
    modeSql: 'p.mode',
    providerSql: "'apple'",
  },
);
export const NO_PENDING_TRANSFER = `NOT EXISTS (SELECT 1 FROM pass_credential_transfers transfer
  WHERE transfer.pass_id=p.id AND transfer.state='pending')`;
