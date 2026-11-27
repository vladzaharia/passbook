// What the kit draws. Structural mirrors of the server's contracts (SetupGuide in
// shared/contracts/connection-setup.ts, the arrival ledger's rows), so the kit imports nothing
// from a space and a server value assigns to them as is.

export type SetupField = 'endpointUrl' | 'secret' | 'signatureHeader' | 'timestampHeader';

export type SetupPart =
  | { t: 'text'; text: string }
  | { t: 'path'; items: readonly string[] }
  | {
      t: 'field';
      label: string;
      value?: string | undefined;
      copy?: SetupField | undefined;
      choose?: boolean | undefined;
    }
  | { t: 'topics' }
  | { t: 'code'; lang: 'sh' | 'curl' | 'ts' | 'py' | 'go'; code: string }
  | { t: 'note'; text: string }
  | { t: 'warn'; text: string };

export interface SetupStep {
  id: string;
  side: 'provider' | 'passbook';
  title: string;
  parts: readonly SetupPart[];
  /** False: the labels were not confirmed against the provider's screen, and the step says so. */
  verified?: boolean | undefined;
}

/** What `copy` fields resolve to. Never the secret of a connection that has one: it is shown once. */
export type SetupValues = Partial<Record<SetupField, string>>;

export interface SetupTopic {
  id: string;
  label?: string | null | undefined;
  required: boolean;
  verified?: boolean | undefined;
}

export type ArrivalOutcome = 'accepted' | 'duplicate' | 'ignored' | 'rejected';
export type ArrivalReason =
  | 'signature_missing'
  | 'signature_mismatch'
  | 'signature_expired'
  | 'payload'
  | 'too_large'
  | 'no_secret'
  | 'unknown_type'
  | 'thin_event'
  | 'test_mode'
  | 'unrecognized_shape'
  | 'no_ref'
  | 'ping'
  | 'stale';

/** One delivery attempt as PassBook saw it: never a body, never personal data. */
export interface Arrival {
  id: string;
  receivedAt: number;
  outcome: ArrivalOutcome;
  reason: ArrivalReason | null;
  /** Only a topic in the recipe's list, or "other". */
  topic: string | null;
  contentClass?: 'json' | 'xml' | 'form' | 'other' | null | undefined;
  /** The retained work of an accepted delivery: matches a failed or blocked item's id. */
  retentionId?: string | null | undefined;
  /** Signed with the secret that rotation replaced. */
  usedPrevious?: boolean | undefined;
  /** Rejects of one kind in one minute coalesce into a row. */
  count?: number | undefined;
}

/** The result of a test send (`POST /v1/webhooks/{id}/test`). */
export interface SendResult {
  ok: boolean;
  status: number | null;
  errorCode?: string | null | undefined;
  durationMs: number;
  requestId?: string | null | undefined;
}
