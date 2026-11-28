import { e2ePorts } from './e2e-ports.ts';

/**
 * The one definition of the e2e app server for every playwright*.config.ts, so timeouts cannot drift.
 * A cold start builds the app and the developer pages; under load that has taken over 120 s.
 */
export function e2eWebServer(env?: Record<string, string>) {
  return {
    command: 'node tools/e2e-server.ts',
    ...(env ? { env } : {}),
    url: `http://localhost:${e2ePorts.web}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
  };
}
