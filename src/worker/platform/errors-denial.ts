import type { EntitlementKey } from '../../shared/contracts/entitlements.ts';
import { sandboxQuota } from '../../shared/copy/developer.ts';
import { ENTITLEMENT_LABEL, limitRefusal } from '../../shared/copy/entitlements.ts';
import {
  IDP_SIGN_IN_REQUIRED_MESSAGE,
  idpEmailNotPrimaryLine,
  PASSKEY_REQUIRED_MESSAGE,
  STEP_UP_REQUIRED_MESSAGE,
} from '../../shared/copy/sign-in.ts';
import { AppError, ConflictError, ForbiddenError, UnauthenticatedError } from './errors-core.ts';

/** 403 `FEATURE_NOT_INCLUDED`: the organization's entitlements lack `feature` (the request guard's refusal). */
export class FeatureNotIncludedError extends AppError {
  constructor(feature: string, message: string) {
    super('FEATURE_NOT_INCLUDED', 403, message, { feature });
  }
}

/**
 * Why a grant refused (section 1.2). Ordered by deny precedence: org first, stale last. `staff` is a
 * bound staff member who changed (409, the device stays paired). `entitlement` and `limit` are the org's
 * Features (design-multi-tenancy.md section 2): a feature that is not included, or a cap that is reached.
 */
export const DENY_REASONS = [
  'org',
  'actor',
  'staff',
  'config',
  'lineage',
  'release',
  'retention',
  'entitlement',
  'limit',
  'stale',
  'proof',
] as const;
export type DenyReason = (typeof DENY_REASONS)[number];

/** The limit a refused grant ran into: the entitlement key, its cap and the org's count. */
export interface LimitHit {
  key: EntitlementKey;
  limit: number;
  used: number;
  /** The org is a developer sandbox: the refusal is SANDBOX_QUOTA. */
  sandbox?: true;
}

/**
 * 403 `FEATURE_LIMIT_REACHED`: a create at the organization's cap; the problem carries the key, cap and
 * count. A `ForbiddenError`, so callers that treat a refused write as a rejection keep doing so.
 */
export class FeatureLimitError extends ForbiddenError {
  constructor({ key, limit, used }: LimitHit) {
    super(limitRefusal(key, limit, used), 'FEATURE_LIMIT_REACHED', { feature: key, limit, used });
  }
}

/** 403 `SANDBOX_QUOTA`: a create at a developer sandbox's cap. Same problem fields as `FeatureLimitError`. */
export class SandboxQuotaError extends ForbiddenError {
  constructor({ key, limit, used }: LimitHit) {
    super(sandboxQuota(ENTITLEMENT_LABEL[key], used, limit), 'SANDBOX_QUOTA', {
      feature: key,
      limit,
      used,
    });
  }
}

export interface DenialOptions {
  /** A scanner whose credential no longer matches must re-pair (401), not retry. */
  scanner?: boolean;
  /** Per-purpose codes, for example `{ stale: 'PASS_CHANGED' }`. */
  codes?: Partial<Record<DenyReason, string>>;
}

/** 409 `ORG_TEST_ONLY`: a Live request on a developer sandbox, which never holds Live. */
export const orgTestOnly = (): ConflictError =>
  new ConflictError('This organization is test-only.', 'ORG_TEST_ONLY');

/** Maps a classified grant refusal to the HTTP error. Unknown reasons are a plain 403. */
export function authorityDenied(
  reason: DenyReason | string,
  options: DenialOptions = {},
): AppError {
  const code = options.codes?.[reason as DenyReason];
  switch (reason) {
    case 'org':
      return new ForbiddenError(
        'Organization access changed. Reload and retry.',
        code ?? 'ORG_ACCESS_CHANGED',
      );
    case 'actor':
      return options.scanner
        ? new UnauthenticatedError('Pair this device again.', code ?? 'SCANNER_REPAIR')
        : new ForbiddenError('You no longer have access.', code ?? 'ACTOR_CHANGED');
    case 'config':
      return new ConflictError(
        'Configuration changed. Reload and retry.',
        code ?? 'SCAN_CONFIG_CHANGED',
      );
    case 'lineage':
      return new ConflictError('The pass changed. Reload and retry.', code ?? 'LINEAGE_CHANGED');
    case 'release':
      return new ConflictError(
        'The template release changed. Reload and retry.',
        code ?? 'TEMPLATE_RELEASE_CHANGED',
      );
    case 'retention':
      return new ConflictError(
        'This record is retained. Reload and retry.',
        code ?? 'RETENTION_CHANGED',
      );
    case 'staff':
      return new ConflictError(
        'Staff changed. Sign in again and retry.',
        code ?? 'SCAN_STAFF_CHANGED',
      );
    case 'entitlement':
      return new ForbiddenError(
        "This isn't included for this organization. Ask PassBook to turn it on.",
        code ?? 'FEATURE_NOT_INCLUDED',
      );
    case 'limit':
      return new ForbiddenError(
        'This organization has reached its limit. Ask PassBook for more.',
        code ?? 'FEATURE_LIMIT_REACHED',
      );
    case 'stale':
      return new ConflictError('The resource changed. Reload and retry.', code ?? 'STALE');
    // A written row and its retention proof disagree: a server fault, never a retained or quarantined record.
    case 'proof':
      return new AppError(
        code ?? 'SCAN_PROOF_MISMATCH',
        500,
        'The record could not be signed. Try again.',
      );
    // Not a DenyReason: only the Live-on-a-developer-org refusal (authority-granted.ts) raises it.
    case 'testonly':
      return orgTestOnly();
    default:
      return new ForbiddenError('You do not have access.', code ?? 'AUTHORITY_DENIED');
  }
}

/** 403 `IDP_SIGN_IN_REQUIRED`: the console and developer tools need a Polaris ID sign-in, not an email link. */
export class IdpSignInRequiredError extends ForbiddenError {
  constructor(signInUrl: string) {
    super(IDP_SIGN_IN_REQUIRED_MESSAGE, 'IDP_SIGN_IN_REQUIRED', { signInUrl });
  }
}

/** 403 `PLATFORM_KEY_REQUIRED`: a platform route met a key that is not a Platform key (an org key, or a bad row). */
export class PlatformKeyRequiredError extends ForbiddenError {
  constructor() {
    super('This needs a platform key.', 'PLATFORM_KEY_REQUIRED');
  }
}

/** 403 `PERSON_REQUIRED`: a platform route, or a request of one, that a key never makes. */
export class PersonRequiredError extends ForbiddenError {
  constructor() {
    super('This needs a person signed in with Polaris ID.', 'PERSON_REQUIRED');
  }
}

/** 403 `STEP_UP_REQUIRED`: the session's sign-in is too old for this action; `signInUrl` asks Polaris ID again. */
export class StepUpRequiredError extends ForbiddenError {
  constructor(signInUrl: string) {
    super(STEP_UP_REQUIRED_MESSAGE, 'STEP_UP_REQUIRED', { signInUrl });
  }
}

/** 403 `IDP_EMAIL_NOT_PRIMARY`: the Polaris ID email is a secondary address of an account; no account is made or bound. */
export class IdpEmailNotPrimaryError extends ForbiddenError {
  constructor(maskedPrimary: string) {
    super(idpEmailNotPrimaryLine(maskedPrimary), 'IDP_EMAIL_NOT_PRIMARY');
  }
}

/** The sign-in page's refusal of a Polaris ID session made with a code instead of a passkey. */
export class PasskeyRequiredError extends ForbiddenError {
  constructor() {
    super(PASSKEY_REQUIRED_MESSAGE, 'PASSKEY_REQUIRED');
  }
}
