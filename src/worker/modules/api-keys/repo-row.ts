import type { Mode } from '../../../shared/contracts/common.ts';
import type { ApiKeyKind } from '../../platform/api-key-token.ts';
import type { Amr } from '../../platform/auth.ts';

export interface ApiKeyRow {
  id: string;
  org_id: string | null;
  name: string;
  prefix: string;
  key_hash: string;
  scopes: string;
  mode: Mode;
  created_by: string | null;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
  kind: ApiKeyKind;
  roles: string;
  membership_id: string | null;
  retire_at: number | null;
  restricted: number;
  ip_allow: string | null;
  rate_tier: string | null;
  secret_label: string;
  parent_key_id: string | null;
  rotated_from: string | null;
  /** The key that made this row: a child's parent, or a key that replaced itself. Null when a person did. */
  created_by_key: string | null;
  last_ip_prefix: string | null;
  /** How the creating person signed in (`oidc`, `magic_link`, `breakglass`). Null: made by a key, or before 0169. */
  created_amr: Amr | null;
  /** `cli`: made by a CLI sign-in (0245). Absent reads as `app`. */
  origin?: 'app' | 'cli';
  /** The creator's `users.access_revision` at mint, for a platform key; null on every other key. Set once (0231). */
  creator_access_revision?: number | null;
}

/** The key a rotation replaces: it retires at `retireAt` in the batch that mints its successor. */
export interface Replaces {
  id: string;
  retireAt: number;
  /** The replaced key's own parent, which the new key keeps. */
  parent: string | null;
  /** A key rotating itself may keep every scope it holds, including the one that lets it mint. */
  self: boolean;
}

/** What a key is written with besides its own row. */
export interface KeyExtras {
  replaces: Replaces;
  terminalIds: readonly string[];
  templateIds: readonly string[];
  passStyles: readonly string[];
}
