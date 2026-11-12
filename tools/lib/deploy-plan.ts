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

const FLAGS = [
  'apply',
  'check',
  'secrets',
  'allow-no-push',
  'allow-no-oidc',
  'first',
  'migrate-only',
  'promote',
] as const;

/**
 * Flags from argv only. npm moves a flag given before `--` (`npm run deploy --migrate-only -- --apply`)
 * into npm_config_migrate_only and out of argv; that is refused, so a misplaced flag never changes
 * what runs.
 */
export function deployFlags(argv: readonly string[], env: Record<string, string | undefined>) {
  const misplaced = FLAGS.filter((name) => env[`npm_config_${name.replaceAll('-', '_')}`]);
  if (misplaced.length > 0)
    throw new Error(
      `Put deploy flags after --: npm run deploy -- ${misplaced.map((n) => `--${n}`).join(' ')}`,
    );
  return new Set(argv);
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

/** Pending migration files from `wrangler d1 migrations list`; null when the output is not recognised. */
export function pendingMigrations(output: string): string[] | null {
  if (output.includes('No migrations to apply')) return [];
  if (!output.includes('Migrations to be applied')) return null;
  const names = [...new Set(output.match(/\b\d{4}_[\w-]+\.sql\b/g) ?? [])];
  return names.length > 0 ? names : null;
}

interface MigrateSteps {
  clearVersion: () => void;
  /** The uploaded version id; null with --first, which uploads nothing. */
  upload: () => string | null;
  bookmark: () => void;
  migrate: () => void;
  saveVersion: (id: string) => void;
}

/**
 * Upload, bookmark, migrate. The version id --promote serves is saved only after the migrations
 * apply, and an older one is cleared first, so a failed run leaves nothing to promote.
 */
export function uploadAndMigrate(steps: MigrateSteps): string | null {
  steps.clearVersion();
  const id = steps.upload();
  steps.bookmark();
  steps.migrate();
  if (id) steps.saveVersion(id);
  return id;
}

const MEMBERSHIPS = '0029_org_memberships.sql';

/**
 * Why a stage must not run against the pending migrations, or null. A full deploy across 0029 (on a
 * database that already has data) would serve the new Worker before the bootstrap; a promote must
 * never serve a schema that is not there yet.
 */
export function pendingRefusal(stage: DeployStage, pending: string[] | null): string | null {
  if (stage === 'migrate') return null;
  if (pending === null)
    return 'Could not read the pending migrations from wrangler. Not deploying.';
  if (stage === 'all' && pending.includes(MEMBERSHIPS) && !pending.includes('0001_platform.sql'))
    return `${MEMBERSHIPS} is pending: this deploy is the cutover. Run --migrate-only --apply, the bootstrap, then --promote --apply (docs/operations.md, "Cutover from schema 0024").`;
  if (stage === 'promote' && pending.length > 0)
    return `Not promoting: ${pending.length} migration(s) pending (${pending[0]} first). Run --migrate-only --apply, then the bootstrap if this is the cutover, and check that verify-memberships returns no rows.`;
  return null;
}
