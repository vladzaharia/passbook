export type AssetGrantBatchResult = { results: readonly unknown[] } & (
  | { success: true }
  | { success: false }
);

export function grantInsertConfirmed(
  results: readonly AssetGrantBatchResult[] | undefined,
): boolean {
  const last = results?.[results.length - 1]?.results?.[0];
  if (
    !results ||
    results.length < 4 ||
    (results[0]?.results?.length ?? 0) !== 1 ||
    !last ||
    typeof last !== 'object' ||
    !('asset_grant_final' in last) ||
    last.asset_grant_final !== 1
  )
    return false;
  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    const row = result?.results?.[0];
    if (
      result?.success !== true ||
      (index > 0 &&
        (!row ||
          typeof row !== 'object' ||
          !('authorized' in row) ||
          row.authorized !== 1 ||
          !('asset_grant_step' in row) ||
          row.asset_grant_step !== index))
    )
      return false;
  }
  return true;
}
