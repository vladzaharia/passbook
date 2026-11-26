import type { OperationKindDef } from './define.ts';

/**
 * What the four holder kinds share. They are the signed-in holder's own: a starter operation, read only
 * by the session that started it, never by an org member or a key. A holder reaches no stop or retry route
 * (those need the console), so none is offered; the pass page starts the action again.
 */
export const holderCommon = {
  audience: 'starter',
  read: null,
  write: null,
  cancel: 'never',
  retry: false,
  stepUp: false,
  stallMs: 5 * 60_000,
} as const satisfies Partial<OperationKindDef>;

/** One active operation per kind and pass. */
export const holderDedupe = (s: Record<string, string>) => `pass:${s.passId}`;

/** Sentences for the codes a holder action can end with: no name, address or code in any of them. */
export const holderErrors = {
  PASS_NOT_FOUND: 'This pass is not available.',
  PASS_CONFLICT: 'The pass changed. Reload and start again.',
  PASS_VOIDED: 'This pass is voided.',
  PASS_CREDENTIAL_FIXED: "This pass's code can't change. Ask the organization.",
  EMAIL_RATE_LIMITED: 'Too many emails to this address. Try again in an hour.',
  RATE_LIMITED: 'Too many tries. Try again in a minute.',
} as const;
