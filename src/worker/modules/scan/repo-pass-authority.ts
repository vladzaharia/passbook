import type { CheckInPolicy } from '../../../shared/contracts/check-in.ts';
import { first } from '../../platform/db.ts';
import type { Pass } from '../passes/repo-map.ts';
import {
  type ActionPassFence,
  type PreparedActionPassFence,
  prepareSnapshotFence,
} from './repo-pass-authority-prepared.ts';
import {
  evaluatedPolicyPredicate,
  passJsonOf,
  passPredicate,
  type ReleaseSnapshot,
  walletStatusOf,
} from './repo-pass-predicates.ts';

export type { ActionPassFence, PreparedActionPassFence } from './repo-pass-authority-prepared.ts';

type Db = D1Database;

async function snapshotCurrent(
  db: Db,
  pass: Pass,
  connectionGeneration: number | null | undefined,
  activeTemplateVersion: string | null | undefined,
  orgRevision: number | null | undefined,
  templateRevision: number | null | undefined,
  now: number,
  release: ReleaseSnapshot | null | undefined,
  purpose: 'read' | 'commit',
): Promise<boolean> {
  const walletStatus = walletStatusOf(passJsonOf(release), now);
  if (
    !walletStatus ||
    (purpose === 'commit' && walletStatus !== 'active') ||
    release?.transferPending !== false ||
    typeof release.walletVersion !== 'number' ||
    release.walletVersion > pass.version ||
    (release.versionPersonalization !== null && typeof release.versionPersonalization !== 'string')
  )
    return false;
  const predicate = passPredicate(pass, connectionGeneration);
  const policy = evaluatedPolicyPredicate(
    activeTemplateVersion,
    orgRevision,
    templateRevision,
    release,
    purpose,
    now,
    walletStatus,
  );
  return (
    (await first(db, `SELECT 1 FROM passes p WHERE ${predicate.sql} AND ${policy.sql}`, [
      ...predicate.params,
      ...policy.params,
    ])) !== null
  );
}

/** Read-side revalidation keeps current role/source projection for incompatible builds. */
export function passSnapshotCurrent(
  db: Db,
  pass: Pass,
  connectionGeneration: number | null | undefined,
  activeTemplateVersion: string | null | undefined,
  orgRevision: number | null | undefined,
  templateRevision: number | null | undefined,
  now: number,
  release: ReleaseSnapshot | null | undefined,
): Promise<boolean> {
  return snapshotCurrent(
    db,
    pass,
    connectionGeneration,
    activeTemplateVersion,
    orgRevision,
    templateRevision,
    now,
    release,
    'read',
  );
}

/** Asset and live disclosure additionally require a compatible pinned build. */
export function passSnapshotCurrentStrict(
  db: Db,
  pass: Pass,
  connectionGeneration: number | null | undefined,
  activeTemplateVersion: string | null | undefined,
  orgRevision: number | null | undefined,
  templateRevision: number | null | undefined,
  now: number,
  release: ReleaseSnapshot | null | undefined,
): Promise<boolean> {
  return snapshotCurrent(
    db,
    pass,
    connectionGeneration,
    activeTemplateVersion,
    orgRevision,
    templateRevision,
    now,
    release,
    'commit',
  );
}

async function snapshotFence(
  db: Db,
  pass: Pass,
  checkInRules: CheckInPolicy | undefined,
  connectionGeneration: number | null | undefined,
  activeTemplateVersion: string | null | undefined,
  orgRevision: number | null | undefined,
  templateRevision: number | null | undefined,
  now: number,
  env: object,
  release: ReleaseSnapshot | null | undefined,
  purpose: 'read' | 'commit',
): Promise<ActionPassFence | null> {
  const prepared = prepareSnapshotFence(
    db,
    pass,
    checkInRules,
    connectionGeneration,
    activeTemplateVersion,
    orgRevision,
    templateRevision,
    now,
    env,
    release,
    purpose,
  );
  if (!prepared || !(await prepared.keysetCurrent)) return null;
  return prepared.complete(await prepared.statement.first<{ rules: string | null }>());
}

/** Fence the original admission policy for a mutation or refusal. */
export function passSnapshotFence(
  db: Db,
  pass: Pass,
  rules: CheckInPolicy | undefined,
  connection: number | null | undefined,
  version: string | null | undefined,
  org: number | null | undefined,
  template: number | null | undefined,
  now: number,
  env: object,
  release: ReleaseSnapshot | null | undefined,
): Promise<ActionPassFence | null> {
  return snapshotFence(
    db,
    pass,
    rules,
    connection,
    version,
    org,
    template,
    now,
    env,
    release,
    'commit',
  );
}

/** A replay reprojects the recorded result under current policy without requiring a compatible build. */
export function passHistoricalSnapshotFence(
  db: Db,
  pass: Pass,
  rules: CheckInPolicy | undefined,
  connection: number | null | undefined,
  version: string | null | undefined,
  org: number | null | undefined,
  template: number | null | undefined,
  now: number,
  env: object,
  release: ReleaseSnapshot | null | undefined,
): Promise<ActionPassFence | null> {
  return snapshotFence(
    db,
    pass,
    rules,
    connection,
    version,
    org,
    template,
    now,
    env,
    release,
    'read',
  );
}

/** Prepare the active-pass read for an atomic claim/effect authority batch. */
export function prepareActionPassFence(
  db: Db,
  pass: Pass,
  checkInRules: CheckInPolicy | undefined,
  connectionGeneration: number | null | undefined,
  activeTemplateVersion: string | null | undefined,
  orgRevision: number | null | undefined,
  templateRevision: number | null | undefined,
  now: number,
  env: object,
  release: ReleaseSnapshot | null | undefined,
): PreparedActionPassFence | null {
  if (pass.status !== 'active' || pass.removedAt !== null) return null;
  return prepareSnapshotFence(
    db,
    pass,
    checkInRules ?? {},
    connectionGeneration,
    activeTemplateVersion,
    orgRevision,
    templateRevision,
    now,
    env,
    release,
    'commit',
    'active',
  );
}

/** Only an active, present pass may enter the check-in gate. */
export async function actionPassFence(
  db: Db,
  pass: Pass,
  checkInRules: CheckInPolicy | undefined,
  connectionGeneration: number | null | undefined,
  activeTemplateVersion: string | null | undefined,
  orgRevision: number | null | undefined,
  templateRevision: number | null | undefined,
  now: number,
  env: object,
  release: ReleaseSnapshot | null | undefined,
): Promise<ActionPassFence | null> {
  const prepared = prepareActionPassFence(
    db,
    pass,
    checkInRules,
    connectionGeneration,
    activeTemplateVersion,
    orgRevision,
    templateRevision,
    now,
    env,
    release,
  );
  return prepared
    ? prepared.complete(await prepared.statement.first<{ rules: string | null }>())
    : null;
}
