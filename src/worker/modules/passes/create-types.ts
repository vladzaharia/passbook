import type { Personalization } from '../../../passkit/types.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import type { ConnectionMode } from '../../../shared/contracts/connections.ts';
import type { SampleScannerScope } from '../scan/sample-scope-fence.ts';
import type { TenantPassWrite } from './http.ts';
import type { RetainedIssuanceClaim } from './repo-write-retained.ts';
import type { Actor } from './service.ts';

export type PassIssuanceExecution =
  | {
      kind: 'tenant';
      authority: TenantPassWrite;
      additionalAuthority?: TenantPassWrite;
      sampleScannerScope?: SampleScannerScope;
    }
  | { kind: 'connection'; connectionId: string; generation: number }
  | { kind: 'system' };

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
  /** The mode explicitly reviewed by the caller (connection syncs are Live-only). */
  mode: Mode;
  /** Generation captured before a connection run fetched its source data. */
  connectionGeneration?: number;
  /** Credential keyset captured before a connection run fetched its source record. */
  credentialKeysetCommitment?: string;
  /** Optional connection strategy captured before the upstream fetch. */
  expectedConnectionMode?: ConnectionMode;
  /** Internal caller provenance, never supplied by a request body. */
  execution: PassIssuanceExecution;
  actor: Actor;
  /** Preassigned pass id; idempotent creates reserve it with the key. */
  passId?: string;
  /** Reserved only by a currently claimed retained webhook item. */
  reservedPassId?: string;
  retainedClaim?: RetainedIssuanceClaim;
}
