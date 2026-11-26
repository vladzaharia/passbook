/** Codes carried as the `CODE: ` prefix of an RPC error message (custom error fields do not cross RPC). */
export const ASC_CODES = [
  'ASC_REFUSED',
  'ASC_BUDGET',
  'ASC_AUTH',
  'ASC_NOT_FOUND',
  'ASC_CONFLICT',
  'ASC_UPSTREAM',
] as const;
export type AscCode = (typeof ASC_CODES)[number];

export class AscError extends Error {
  readonly code: AscCode;
  constructor(code: AscCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'AscError';
    this.code = code;
  }
}

export interface ProvisionerEnv {
  DB: D1Database;
  ASC_KEY_P8: string;
  ASC_KEY_ID: string;
  ASC_ISSUER_ID: string;
}

export interface PassTypeRef {
  ascId: string;
  identifier: string;
  name: string | null;
}
/** `existing`: already allowlisted here, no Apple call. `adopted`: Apple already had it (an earlier attempt). */
export interface CreatedPassType extends PassTypeRef {
  outcome: 'created' | 'existing' | 'adopted';
}
export interface CertificateInfo {
  ascId: string;
  certificateType: string;
  serialNumber: string | null;
  /** Epoch ms, or null when Apple omits it. */
  expiresAt: number | null;
  /** DER bytes (Apple returns base64). */
  der: Uint8Array | null;
}
export interface CallRow {
  id: number;
  callId: string;
  phase: string;
  method: string;
  target: string | null;
  caller: string | null;
  status: string | null;
  appleRequestId: string | null;
  durationMs: number | null;
  at: number;
}

/** The RPC surface of the `apple-provisioner` Worker, and nothing else. `runId` is the caller's workflow run, for the ledger. */
export interface AppleRpc {
  createPassType(handle: string, name: string, runId?: string): Promise<CreatedPassType>;
  /** Orders or adopts one of the two fixed platform pass types. No identifier crosses the RPC. */
  createPlatformPassType(slot: 'root' | 'devtest', runId?: string): Promise<CreatedPassType>;
  createCertificate(
    passTypeAscId: string,
    csrDer: Uint8Array,
    nfc: boolean,
    runId?: string,
  ): Promise<CertificateInfo>;
  /** The main Worker calls this once a certificate is live; a revoke of its predecessor waits for it. */
  reportCertificateActive(certAscId: string, runId?: string): Promise<void>;
  listCertificates(passTypeAscId: string, runId?: string): Promise<CertificateInfo[]>;
  revokeCertificate(certAscId: string, reason: 'compromised', runId?: string): Promise<void>;
  findPassType(identifier: string, runId?: string): Promise<PassTypeRef | null>;
  calls(since: number): Promise<CallRow[]>;
}
