import type { Personalization } from '../../../passkit/types.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import type { ConnectionMode } from '../../../shared/contracts/connections.ts';
import type { SampleScannerScope } from '../scan/sample-scope-fence.ts';
import type { TenantPassWrite } from './http.ts';
import type { DeferredStarter } from './repo-bulk-principal.ts';
import type { RetainedIssuanceClaim } from './repo-write-retained.ts';
import type { Actor } from './service.ts';

export interface JoinKeys {
  ipKey: string | null;
  deviceKey: string | null;
  fieldsHash: string | null;
}

export type PassIssuanceExecution =
  | {
      kind: 'tenant';
      authority: TenantPassWrite;
      additionalAuthority?: TenantPassWrite;
      sampleScannerScope?: SampleScannerScope;
    }
  | { kind: 'connection'; connectionId: string; generation: number }
  | { kind: 'system' }
  /** A bulk import's create: the starter is re-proved in the grant. `guard` refuses a live pass with that External ID. */
  | { kind: 'deferred'; starter: DeferredStarter; guard?: { externalId: string } }
  /** A public join link: the pass is pinned to the link's org and mode, owner NULL, caps in the grant. */
  | { kind: 'join'; linkId: string; generation: number; orgDailyCap: number };

export interface CreateParams {
  orgId: string;
  templateId: string;
  /** The exact approved template version used by this issuance. */
  templateVersion: string;
  releaseId?: string;
  releaseGeneration?: number;
  identityId?: string;
  input: Personalization;
  holderEmail?: string | null;
  externalId?: string | null;
  serial?: string;
  connectionId?: string | null;
  externalRef?: string | null;
  sendEmail?: boolean;
  source: 'manual' | 'connection';
  /** Marks each input key with this source instead of `source` (an import's own fields). */
  fieldSource?: 'import';
  /** The mode explicitly reviewed by the caller (connection syncs are Live-only). */
  mode: Mode;
  /** Generation captured before a connection run fetched its source data. */
  connectionGeneration?: number;
  /** Credential keyset captured before a connection run fetched its source record. */
  credentialKeysetCommitment?: string;
  /** Optional connection strategy captured before the upstream fetch. */
  expectedConnectionMode?: ConnectionMode;
  /** Join ledger digests (ip, device, fields); only a `join` execution may carry them. */
  joinKeys?: JoinKeys;
  /** Internal caller provenance, never supplied by a request body. */
  execution: PassIssuanceExecution;
  actor: Actor;
  /** Preassigned pass id; idempotent creates reserve it with the key. */
  passId?: string;
  /** Reserved only by a currently claimed retained webhook item. */
  reservedPassId?: string;
  retainedClaim?: RetainedIssuanceClaim;
}
