/** Names in `secrets.required` that the Worker does not have, given `wrangler secret list --format json`. */
export function missingSecrets(required: readonly string[], listOutput: string): string[] {
  const parsed: unknown = JSON.parse(listOutput);
  const present = new Set(
    Array.isArray(parsed)
      ? parsed.flatMap((s: unknown) =>
          s && typeof s === 'object' && 'name' in s && typeof s.name === 'string' ? [s.name] : [],
        )
      : [],
  );
  return required.filter((name) => !present.has(name));
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * The id of the uploaded version, from WRANGLER_OUTPUT_FILE_PATH entries (one JSON object per line)
 * or, failing that, the "Worker Version ID: <uuid>" line.
 */
export function parseVersionId(outputFile: string, stdout: string): string | null {
  for (const line of outputFile.split('\n')) {
    try {
      const entry: unknown = JSON.parse(line);
      if (
        entry &&
        typeof entry === 'object' &&
        'type' in entry &&
        entry.type === 'version-upload' &&
        'version_id' in entry &&
        typeof entry.version_id === 'string'
      )
        return entry.version_id;
    } catch {
      // Not a JSON line.
    }
  }
  const labelled = stdout.match(new RegExp(`Worker Version ID:\\s*(${UUID.source})`, 'i'));
  return labelled?.[1] ?? null;
}

const ENV_FLAGS = ['allow-no-push', 'allow-no-oidc', 'secrets', 'first'] as const;

/**
 * Flags from argv, plus the ones npm exports when given before `--`
 * (`npm run deploy --allow-no-push` sets npm_config_allow_no_push). `--apply` is never read from
 * the environment.
 */
export function deployFlags(argv: readonly string[], env: Record<string, string | undefined>) {
  const flags = new Set(argv);
  for (const name of ENV_FLAGS)
    if (env[`npm_config_${name.replaceAll('-', '_')}`] === 'true') flags.add(`--${name}`);
  return flags;
}

export type DeployStage = 'all' | 'migrate' | 'promote';

/**
 * `--migrate-only` stops after the migrations so the cutover bootstrap can run before anything serves
 * the new schema; `--promote` then serves what was uploaded. Neither: the whole flow in one run.
 */
export function deployStage(flags: ReadonlySet<string>): DeployStage {
  const migrate = flags.has('--migrate-only');
  const promote = flags.has('--promote');
  if (migrate && promote) throw new Error('--migrate-only and --promote are separate runs.');
  return migrate ? 'migrate' : promote ? 'promote' : 'all';
}
