import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import type { CredentialTombstoneSnapshot } from './credential-input.ts';
import type { Candidate } from './repo-lookup.ts';

/** Worker-only provenance; only outcome is serialized onto the scanner wire. */
export interface ScanEvaluation {
  outcome: ScanOutcome;
  evaluatedSnapshot: Candidate | null;
  /** Input authority used for live publication; never serialized as an API response. */
  credentialContext: CredentialTombstoneSnapshot | null;
}
