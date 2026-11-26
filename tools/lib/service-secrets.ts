import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { missingSecrets } from './deploy-plan.ts';
import { readJsonc } from './jsonc.ts';

interface WorkerConfig {
  name?: string;
  secrets?: { required?: string[] };
}

/**
 * The Workers the main config binds as services (APPLE, IDP) that live in `workers/<dir>/wrangler.jsonc`,
 * with the secrets each one requires. A bound Worker that does not exist, or lacks its secrets, would
 * deploy the main Worker against a dead binding.
 */
export function serviceSecretChecks(
  services: readonly { service: string }[] | undefined,
  workersDir: string,
): { service: string; required: string[] }[] {
  const byName = new Map<string, string[]>();
  for (const dir of existsSync(workersDir) ? readdirSync(workersDir) : []) {
    const file = join(workersDir, dir, 'wrangler.jsonc');
    if (!existsSync(file)) continue;
    const config = readJsonc<WorkerConfig>(file);
    if (config.name) byName.set(config.name, config.secrets?.required ?? []);
  }
  return (services ?? []).flatMap(({ service }) => {
    const required = byName.get(service);
    return required ? [{ service, required }] : [];
  });
}

/** Exits 1 when a bound connector Worker lacks secrets. `list` is `wrangler secret list --name <service> --format json`. */
export function requireServiceSecrets(
  services: readonly { service: string }[] | undefined,
  workersDir: string,
  list: (service: string) => string,
): void {
  const problems = serviceSecretChecks(services, workersDir).flatMap(({ service, required }) => {
    const gone = missingSecrets(required, list(service));
    return gone.length > 0
      ? [`${service} lacks secrets (wrangler secret put --name ${service}): ${gone.join(', ')}`]
      : [];
  });
  if (problems.length === 0) return;
  console.error(`Not migrating:\n${problems.map((p) => `- ${p}`).join('\n')}`);
  process.exit(1);
}
