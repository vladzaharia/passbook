export interface WalletSnapshot {
  pass: { serial: string };
  /** The persisted pass JSON from the evaluated D1 snapshot. */
  passJsonSnapshot: string | null;
  identityPassTypeIdentifier: string | null;
  identityTeamIdentifier: string | null;
}

/** `parsed` must be the result of parsing this snapshot's persisted `passJsonSnapshot`. */
export function walletIdentityMatches(snapshot: WalletSnapshot, parsed: unknown): boolean {
  if (
    typeof snapshot.passJsonSnapshot !== 'string' ||
    snapshot.passJsonSnapshot.length === 0 ||
    !snapshot.pass.serial ||
    !snapshot.identityPassTypeIdentifier ||
    !snapshot.identityTeamIdentifier ||
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed)
  )
    return false;
  const json = parsed as Record<string, unknown>;
  return (
    json.serialNumber === snapshot.pass.serial &&
    json.passTypeIdentifier === snapshot.identityPassTypeIdentifier &&
    json.teamIdentifier === snapshot.identityTeamIdentifier
  );
}
