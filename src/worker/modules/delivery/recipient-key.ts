import { keyedDigest } from '../../platform/crypto.ts';

/** Counter key part for one recipient address: keyed, so stored counters do not expose it. */
export const recipientKey = (env: object, to: string): Promise<string> =>
  keyedDigest(env, 'counter.pass-email.v1', to.toLowerCase());
