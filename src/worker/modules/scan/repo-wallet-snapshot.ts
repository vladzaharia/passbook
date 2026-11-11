export interface WalletIdentitySql {
  /** Trusted SQL expressions; bind placeholders in the order they appear below. */
  passAlias?: string;
  snapshotSql?: string;
  walletVersionSql?: string;
  walletTemplateVersionSql?: string;
  personalizationSql?: string;
  passTypeIdentifierSql?: string;
  teamIdentifierSql?: string;
  identityRevisionSql?: string;
}

export interface WalletSnapshotSql extends WalletIdentitySql {
  nowSql: string;
  status?: 'active' | 'voided' | 'expired';
}

function walletPredicateSql(input: WalletIdentitySql, statusSql: string): string {
  const pass = input.passAlias ?? 'p';
  return `EXISTS (
    SELECT 1 FROM pass_versions wallet
    JOIN signing_identities si ON si.id=${pass}.identity_id AND (si.org_id IS NULL OR si.org_id=${pass}.org_id)
    WHERE (wallet.pass_id=${pass}.id AND wallet.version=(
      SELECT v.version FROM pass_versions v WHERE v.pass_id=${pass}.id AND v.version<=${pass}.version
      ORDER BY v.version DESC LIMIT 1
    ))
    AND (1
      ${input.snapshotSql ? `AND wallet.pass_json IS ${input.snapshotSql}` : ''}
      ${input.walletVersionSql ? `AND wallet.version=${input.walletVersionSql}` : ''}
      ${input.walletTemplateVersionSql ? `AND wallet.template_version IS ${input.walletTemplateVersionSql}` : ''}
      ${input.personalizationSql ? `AND wallet.personalization IS ${input.personalizationSql}` : ''})
    AND (1
      ${input.passTypeIdentifierSql ? `AND si.pass_type_identifier=${input.passTypeIdentifierSql}` : ''}
      ${input.teamIdentifierSql ? `AND si.team_identifier=${input.teamIdentifierSql}` : ''}
      ${input.identityRevisionSql ? `AND si.revision=${input.identityRevisionSql}` : ''})
    AND CASE WHEN json_valid(wallet.pass_json) THEN
      ((json_type(wallet.pass_json)='object'
          AND json_type(wallet.pass_json,'$.serialNumber')='text'
          AND length(json_extract(wallet.pass_json,'$.serialNumber'))>0
          AND json_extract(wallet.pass_json,'$.serialNumber')=${pass}.serial)
        AND (json_type(wallet.pass_json,'$.passTypeIdentifier')='text'
          AND length(json_extract(wallet.pass_json,'$.passTypeIdentifier'))>0
          AND json_extract(wallet.pass_json,'$.passTypeIdentifier')=si.pass_type_identifier))
      AND ((json_type(wallet.pass_json,'$.teamIdentifier')='text'
          AND length(json_extract(wallet.pass_json,'$.teamIdentifier'))>0
          AND json_extract(wallet.pass_json,'$.teamIdentifier')=si.team_identifier)
        AND (json_type(wallet.pass_json,'$.voided') IS NULL
          OR json_type(wallet.pass_json,'$.voided') IN ('true','false')))
      AND (json_type(wallet.pass_json,'$.expirationDate') IS NULL OR (
        (((json_type(wallet.pass_json,'$.expirationDate')='text'
            AND substr(json_extract(wallet.pass_json,'$.expirationDate'),1,10)
              GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
          AND (substr(json_extract(wallet.pass_json,'$.expirationDate'),11,1)='T'
            AND substr(json_extract(wallet.pass_json,'$.expirationDate'),12,5)
              GLOB '[0-9][0-9]:[0-9][0-9]'))
          AND (substr(json_extract(wallet.pass_json,'$.expirationDate'),-1)='Z'
            OR (substr(json_extract(wallet.pass_json,'$.expirationDate'),-6,1) IN ('+','-')
              AND substr(json_extract(wallet.pass_json,'$.expirationDate'),-5) GLOB '[0-9][0-9]:[0-9][0-9]')))
        AND (date(substr(json_extract(wallet.pass_json,'$.expirationDate'),1,10),'+0 days')=
          substr(json_extract(wallet.pass_json,'$.expirationDate'),1,10)
          AND julianday(json_extract(wallet.pass_json,'$.expirationDate')) IS NOT NULL)))
      ${statusSql ? `AND (${statusSql})` : ''}
    ELSE 0 END
  )`;
}

/** Latest stored Wallet JSON must match the pass and its signing identity, regardless of validity. */
export function walletIdentityPredicateSql(input: WalletIdentitySql = {}): string {
  return walletPredicateSql(input, '');
}

/** The latest stored Wallet JSON must also retain the evaluated validity state. */
export function walletSnapshotPredicateSql(input: WalletSnapshotSql): string {
  const nonvoid = `(json_type(wallet.pass_json,'$.voided') IS NULL
    OR json_type(wallet.pass_json,'$.voided')='false')`;
  const expiration = `json_extract(wallet.pass_json,'$.expirationDate')`;
  const date = `json_type(wallet.pass_json,'$.expirationDate')='text' AND julianday(${expiration}) IS NOT NULL`;
  const milliseconds = `ROUND((julianday(${expiration})-2440587.5)*86400000)`;
  const status =
    input.status === 'voided'
      ? `json_type(wallet.pass_json,'$.voided')='true' AND ${input.nowSql} IS NOT NULL`
      : input.status === 'expired'
        ? `${nonvoid} AND ${date} AND ${milliseconds}<${input.nowSql}`
        : `${nonvoid} AND (json_type(wallet.pass_json,'$.expirationDate') IS NULL
          OR (${date} AND ${milliseconds}>=${input.nowSql}))`;
  return walletPredicateSql(input, status);
}
