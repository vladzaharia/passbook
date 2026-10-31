/** Worker environment. `Env` comes from `wrangler types`; this adds bindings that are optional at runtime. */
export interface AppEnv extends Omit<Env, 'APNS'> {
  /**
   * Absent until the platform certificate is uploaded; treated as "push unavailable".
   * Omit keeps a generated required `APNS` (mtls_certificates uncommented) from clashing.
   */
  APNS?: Fetcher;
  /** Optional ceiling on the daily magic-link volume. */
  MAGIC_LINK_DAILY_CAP?: string;
  /** Optional chain override; defaults to the bundled WWDR G4. */
  SIGNER_PLATFORM_INTERMEDIATE?: string;
  KEK_V2?: string;
  KEK_V3?: string;
}

export type RateLimitName =
  | 'RL_LOGIN'
  | 'RL_MAGIC_LINK'
  | 'RL_PUBLIC'
  | 'RL_APPLE'
  | 'RL_API_KEY'
  | 'RL_WEBHOOK'
  | 'RL_REFRESH';

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
