/**
 * The portal's CSP has no unsafe-eval and Trusted Types are on, so zod must not compile its
 * parsers (its probe, `Function('')`, logs a violation). It decides when its first schema is built,
 * which is when its chunk loads, before any code of ours could call `z.config`. zod reads its config
 * from this global at that moment (zod/v4/core/core.js), so the island's entry calls this before it
 * loads the page, importing nothing. jitless.test.ts pins the key.
 */
export const ZOD_CONFIG_KEY = '__zod_globalConfig';

export function disableZodCompiling(): void {
  const host = globalThis as unknown as Record<string, { jitless?: boolean } | undefined>;
  const config = host[ZOD_CONFIG_KEY] ?? {};
  config.jitless = true;
  host[ZOD_CONFIG_KEY] = config;
}
