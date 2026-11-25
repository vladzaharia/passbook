/** The `IDP` service binding's RPC surface (dev-invite-design.md 3.2). The provisioner Worker implements it. */
export interface IdpHealth {
  /** The developers group's name as Pocket ID reports it; it must equal `OIDC_DEVELOPER_GROUP`. */
  groupName: string;
  /** Reasons the provisioner refuses writes; empty when safe. */
  unsafe: string[];
  /** The provisioner key's expiry (ms), or null when unknown. */
  keyExpiresAt: number | null;
  layout: 'v2' | 'admin';
}

export interface IdpSignup {
  tokenId: string;
  /** A bearer link: never logged or stored. */
  url: string;
  expiresAt: number;
}

export interface IdpCall {
  at: number;
  method: string;
  phase: 'start' | 'end' | 'refused' | 'budget';
  ref: string | null;
  code: string | null;
}

export interface IdpRpc {
  health(): Promise<IdpHealth>;
  createSignup(ref: string): Promise<IdpSignup>;
  deleteSignup(tokenId: string): Promise<'deleted' | 'used' | 'gone'>;
  proveSignup(
    tokenIds: string[],
    subject?: string,
  ): Promise<{ tokenId: string; subject: string } | null>;
  addDeveloper(subject: string, ref: string): Promise<'added' | 'already'>;
  removeDeveloper(subject: string, reason: string): Promise<'removed' | 'absent' | 'not_ours'>;
  calls(since: number): Promise<IdpCall[]>;
}
