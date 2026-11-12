// A historical NULL (or malformed value) is not proof of the current keyset.
export const validCommitmentSql = (column: string) =>
  `typeof(${column}) = 'text' AND length(${column}) = 64 AND length(CAST(${column} AS BLOB)) = 64
    AND ${column} NOT GLOB '*[^0-9a-f]*'`;
