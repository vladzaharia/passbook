import { execFileSync } from 'node:child_process';
import { BASE } from './api.ts';

/**
 * Runs the platform's minute cron once, as the clock would. workerd serves this path itself in
 * local dev and in `vite preview`; a deployed Worker has no such route, so nothing here can reach
 * production. Hooks that wait out a quiet minute (the rollout rebuild) need a call after it.
 */
export async function runMinuteCron(): Promise<void> {
  const res = await fetch(
    `${BASE}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent('* * * * *')}`,
  );
  if (!res.ok) throw new Error(`The minute cron did not run: ${res.status}`);
}

/**
 * Records, as the rebuild does, why one pass could not move to the active release. The rebuild only
 * fails a card when it holds more stamps than the new version allows, and a release is refused while
 * such cards exist, so a spec cannot make that happen through the API: it writes the row instead.
 * Local database only: wrangler's `--local` never reaches a deployed one.
 */
export function recordRolloutFailure(input: {
  passId: string;
  releaseId: string;
  code: string;
  message: string;
}): void {
  const quote = (v: string) => `'${v.replaceAll("'", "''")}'`;
  execFileSync(
    'npx',
    [
      'wrangler',
      'd1',
      'execute',
      'passbook-platform',
      '--local',
      '--persist-to',
      '.wrangler/e2e-state',
      '--command',
      `INSERT INTO template_rollout_failures (pass_id, release_id, code, message, at) VALUES (${quote(input.passId)}, ${quote(input.releaseId)}, ${quote(input.code)}, ${quote(input.message)}, ${Date.now()})`,
    ],
    { stdio: 'pipe' },
  );
}
