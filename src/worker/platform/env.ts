import type { Job } from '../jobs/types.ts';

/** Worker environment. `Env` comes from `wrangler types`; this adds bindings that are optional at runtime. */
export interface AppEnv
  extends Omit<
    Env,
    'APNS' | 'BREAKGLASS_TOKEN_SHA256' | 'JOBS' | 'JOBS_DLQ' | 'WEBHOOK_JOBS' | 'OIDC_CLIENT_SECRET'
  > {
  /** The generated type is Queue<unknown>; producers are checked against `Job`. */
  JOBS: Queue<Job>;
  JOBS_DLQ: Queue<Job>;
  /** Outbound webhook lanes only (`wallet-webhooks`), served by the same consumer. */
  WEBHOOK_JOBS: Queue<Job>;
  /**
   * Absent until the platform certificate is uploaded; treated as "push unavailable".
   * Omit keeps a generated required `APNS` (mtls_certificates uncommented) from clashing.
   */
  APNS?: Fetcher;
  /** Only for a registered Pocket ID client; a CIMD client id (oidc-cimd.ts) has no secret. */
  OIDC_CLIENT_SECRET?: string;
  /** SHA-256 of the break-glass token. Unset turns the route off. */
  BREAKGLASS_TOKEN_SHA256?: string;
  /** Bearer token Polaris ID presents to the SCIM receiver (`/scim/v2`). Unset turns the receiver off. */
  SCIM_BEARER_TOKEN?: string;
  /** Rate tier for API keys with none stored: standard, high or bulk. Unset or unknown means standard. */
  API_RATE_TIER_DEFAULT?: string;
  /** Optional ceiling on the daily magic-link volume. */
  MAGIC_LINK_DAILY_CAP?: string;
  /** Optional chain override; defaults to the bundled WWDR G4. */
  SIGNER_PLATFORM_INTERMEDIATE?: string;
  /** KEK version the MAC keys derive from; unset means root 1 (`EVIDENCE_ROOT`). See docs/operations.md, MAC key rotation. */
  MAC_KEY_VERSION?: string;
  /** Set only while `tokens.remac` rewrites MACs after MAC_KEY_VERSION changed: the version they were under. */
  MAC_KEY_VERSION_PREVIOUS?: string;
  /** Not a required secret: once a newer KEK holds every envelope, KEK_V1 is retired (docs/operations.md, KEK rotation). */
  KEK_V1?: string;
  KEK_V2?: string;
  KEK_V3?: string;
  /**
   * HKDF-Extract of the KEK of that version (tools/keys.ts mac-root): derives every MAC key and opens no
   * envelope, but it forges every token and evidence MAC the KEK would, so keep it as secret as the KEK and
   * escrow it the same way.
   */
  MAC_ROOT_V1?: string;
  MAC_ROOT_V2?: string;
}

/** Binding names come from the generated Env, so renaming a ratelimits entry fails typecheck. */
export type RateLimitName = { [K in keyof Env]: Env[K] extends RateLimit ? K : never }[keyof Env];

export const RATE_LIMITS = [
  'RL_LOGIN',
  'RL_MAGIC_LINK',
  'RL_PUBLIC',
  'RL_PUBLIC_ASSET',
  'RL_APPLE',
  'RL_APPLE_IP',
  'RL_API_KEY',
  'RL_API_KEY_HIGH',
  'RL_API_KEY_BULK',
  'RL_API_ORG',
  'RL_API_TRY',
  'RL_API_TRY_ASSET',
  'RL_WEBHOOK',
  'RL_REFRESH',
  'RL_SCAN_PAIR',
  'RL_SCAN',
  'RL_SCAN_LOOKUP',
  'RL_SCAN_ORG',
  'RL_SCAN_DRAFT',
  'RL_GOOGLE_CALLBACK',
  'RL_WEBHOOK_HOST',
  'RL_WEBHOOK_HOST_ORG',
  'RL_WEBHOOK_OUT',
  'RL_JOIN',
  'RL_TEMPLATE_UPLOAD',
  'RL_SESSION',
  'RL_ACCESS',
  'RL_ACCESS_ALL',
  'RL_PLATFORM_WRITE',
  'RL_SIMULATE',
  'RL_WEBHOOK_LEDGER',
  'RL_SANDBOX_DELIVERY',
  'RL_CLI_START',
  'RL_CLI_POLL',
] as const satisfies readonly RateLimitName[];

/**
 * Fails to compile when a ratelimits binding is missing from RATE_LIMITS.
 * @public
 */
export const RATE_LIMITS_COVER_ALL: [Exclude<RateLimitName, (typeof RATE_LIMITS)[number]>] extends [
  never,
]
  ? true
  : never = true;

/** Reads a string secret or var that is not part of the generated `Env` (e.g. SIGNER_<PREFIX>_*). */
export function envString(env: object, name: string): string | undefined {
  const value = (env as Record<string, unknown>)[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function baseUrl(env: Pick<AppEnv, 'PUBLIC_BASE_URL'>): string {
  return env.PUBLIC_BASE_URL.replace(/\/+$/, '');
}
