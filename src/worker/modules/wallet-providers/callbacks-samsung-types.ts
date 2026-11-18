import { UnauthenticatedError } from '../../platform/errors.ts';
import type { SamsungCardEvent } from './repo-callbacks-state.ts';

export type SamsungCallbackResult =
  | { kind: 'card'; cdata: string }
  | { kind: 'accepted' }
  | { kind: 'missing' };

/** One callback, parsed before any lookup. Query values are unsigned unless the token binds them. */
export interface SamsungCallbackInput {
  request: Request;
  refId: string;
  refHash: string;
  method: 'GET' | 'POST';
  credentialKeysetCommitment: string;
  /** Get Card Data only. */
  fields: string[] | null;
  /** Send Card State only. */
  countryHint: string | null;
  event: SamsungCardEvent | null;
  body: Uint8Array | null;
  requestId: string;
}

export const unauthenticated = () =>
  new UnauthenticatedError('Samsung Wallet authorization is invalid.', 'SAMSUNG_UNAUTHENTICATED');
