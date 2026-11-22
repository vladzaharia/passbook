import { PREVIEW_PASS_IDENTITY } from '../../../shared/copy/developer.ts';

/**
 * The wallet identity a pass is built under. A sandbox's passes are built with the preview identity (they
 * sign nothing) though the row stores the platform's; `si` is the pass's identity row.
 */
export const walletIdentityColumn = (
  column: 'pass_type_identifier' | 'team_identifier',
  pass = 'p',
): string => {
  const preview =
    PREVIEW_PASS_IDENTITY[
      column === 'pass_type_identifier' ? 'passTypeIdentifier' : 'teamIdentifier'
    ];
  return `(CASE WHEN EXISTS (SELECT 1 FROM developer_sandboxes ds WHERE ds.org_id=${pass}.org_id) THEN '${preview}' ELSE si.${column} END)`;
};

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
      ${input.passTypeIdentifierSql ? `AND ${walletIdentityColumn('pass_type_identifier', pass)}=${input.passTypeIdentifierSql}` : ''}
      ${input.teamIdentifierSql ? `AND ${walletIdentityColumn('team_identifier', pass)}=${input.teamIdentifierSql}` : ''}
      ${input.identityRevisionSql ? `AND si.revision=${input.identityRevisionSql}` : ''})
    AND CASE WHEN json_valid(wallet.pass_json) THEN
      ((json_type(wallet.pass_json)='object'
          AND json_type(wallet.pass_json,'$.serialNumber')='text'
          AND length(json_extract(wallet.pass_json,'$.serialNumber'))>0
          AND json_extract(wallet.pass_json,'$.serialNumber')=${pass}.serial)
        AND (json_type(wallet.pass_json,'$.passTypeIdentifier')='text'
          AND length(json_extract(wallet.pass_json,'$.passTypeIdentifier'))>0
          AND json_extract(wallet.pass_json,'$.passTypeIdentifier')=${walletIdentityColumn('pass_type_identifier', pass)}))
      AND ((json_type(wallet.pass_json,'$.teamIdentifier')='text'
          AND length(json_extract(wallet.pass_json,'$.teamIdentifier'))>0
          AND json_extract(wallet.pass_json,'$.teamIdentifier')=${walletIdentityColumn('team_identifier', pass)})
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
