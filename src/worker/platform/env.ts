/** Worker environment. `Env` comes from `wrangler types`; this adds bindings that are optional at runtime. */
export interface AppEnv
  extends Omit<Env, 'APNS' | 'BREAKGLASS_TOKEN_SHA256' | 'OIDC_CLIENT_SECRET'> {
  /**
   * Absent until the platform certificate is uploaded; treated as "push unavailable".
   * Omit keeps a generated required `APNS` (mtls_certificates uncommented) from clashing.
   */
  APNS?: Fetcher;
  /** Only for a registered Pocket ID client; a CIMD client id (oidc-cimd.ts) has no secret. */
  OIDC_CLIENT_SECRET?: string;
  /** SHA-256 of the break-glass token. Unset turns the route off. */
  BREAKGLASS_TOKEN_SHA256?: string;
  /** Optional ceiling on the daily magic-link volume. */
  MAGIC_LINK_DAILY_CAP?: string;
  /** Optional chain override; defaults to the bundled WWDR G4. */
  SIGNER_PLATFORM_INTERMEDIATE?: string;
  KEK_V2?: string;
  KEK_V3?: string;
}

/** Binding names come from the generated Env, so renaming a ratelimits entry fails typecheck. */
export type RateLimitName = { [K in keyof Env]: Env[K] extends RateLimit ? K : never }[keyof Env];

export const RATE_LIMITS = [
  'RL_LOGIN',
  'RL_MAGIC_LINK',
  'RL_PUBLIC',
  'RL_APPLE',
  'RL_APPLE_IP',
  'RL_API_KEY',
  'RL_WEBHOOK',
  'RL_REFRESH',
] as const satisfies readonly RateLimitName[];

/** Fails to compile when a ratelimits binding is missing from RATE_LIMITS. */
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

export function requireEnvString(env: object, name: string): string {
  const value = envString(env, name);
  if (!value) throw new Error(`Missing environment value ${name}`);
  return value;
}

export function baseUrl(env: Pick<AppEnv, 'PUBLIC_BASE_URL'>): string {
  return env.PUBLIC_BASE_URL.replace(/\/+$/, '');
}
