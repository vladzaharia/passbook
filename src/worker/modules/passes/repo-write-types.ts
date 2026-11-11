import type { Personalization } from '../../../passkit/types.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import type { ConnectionMode } from '../../../shared/contracts/connections.ts';
import type { PassIssuanceExecution } from './create-types.ts';
import type { FieldSources } from './repo-map.ts';
import type { PassReleaseSnapshot } from './repo-release.ts';
import type { RetainedIssuanceClaim } from './repo-write-retained.ts';

export interface NewPassRow {
  id: string;
  orgId: string;
  identityId: string;
  serial: string;
  templateId: string;
  templateVersion: string;
  /** Approved release snapshot used to build the pass. */
  release: PassReleaseSnapshot;
  authToken: string;
  downloadToken: string;
  webServiceUrl: string;
  credentialKeysetCommitment: string;
  credentialRefs: string[];
  personalization: Personalization;
  fieldSources: FieldSources;
  displayTitle: string | null;
  displaySubtitle: string | null;
  externalId: string | null;
  holderEmail: string | null;
  connectionId: string | null;
  connectionGeneration: number | null;
  expectedConnectionMode?: ConnectionMode;
  /** Present only for issuance reserved by a started retained webhook item. */
  reservedPassId?: string;
  retainedClaim?: RetainedIssuanceClaim;
  externalRef: string | null;
  /** Distinguishes a captured connection run from manual or trusted system issuance. */
  source: 'manual' | 'connection';
  objectKey: string;
  objectSha256: string;
  objectSize: number;
  contentHash: string;
  now: number;
  createdBy: string | null;
  passJson: string;
  actorType: string | null;
  actorId: string | null;
  requestId?: string | null;
  /** Persist a recoverable issuance-email intent in the creation transaction. */
  sendEmail?: boolean;
  mode: Mode;
  scanCode: string;
  barcodeHash: string | null;
  lookupHash: string | null;
  execution: PassIssuanceExecution;
}
