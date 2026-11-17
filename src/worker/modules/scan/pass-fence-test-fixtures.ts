import type { CheckInPolicy } from '../../../shared/contracts/check-in.ts';
import type { Pass } from '../passes/repo-map.ts';
import {
  type ActionPassFence,
  passSnapshotFence as fenceOf,
  prepareActionPassFence,
} from './repo-act-pass-fence.ts';
import type { Candidate } from './repo-lookup.ts';

type Release = Candidate;

/** The pass fence of a refusal or heads-up answer, from the candidate the answer was read from. */
export function passSnapshotFence(
  db: D1Database,
  pass: Pass,
  rules: CheckInPolicy | undefined,
  connection: number | null | undefined,
  version: string | null | undefined,
  org: number | null | undefined,
  template: number | null | undefined,
  now: number,
  env: object,
  release: Release | null | undefined,
): Promise<ActionPassFence | null> {
  return fenceOf(
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
    release?.templateSnapshot?.raw,
  );
}

/** Whether the pass fence of an answer holds now. */
export async function passSnapshotCurrent(
  env: { DB: D1Database },
  pass: Pass,
  connection: number | null | undefined,
  version: string | null | undefined,
  org: number | null | undefined,
  template: number | null | undefined,
  now: number,
  release: Release | null | undefined,
): Promise<boolean> {
  return (
    (await passSnapshotFence(
      env.DB,
      pass,
      undefined,
      connection,
      version,
      org,
      template,
      now,
      env,
      release,
    )) !== null
  );
}

export const passSnapshotCurrentStrict = passSnapshotCurrent;

/** The pass fence of an action on an active pass. */
export async function actionPassFence(
  db: D1Database,
  pass: Pass,
  rules: CheckInPolicy | undefined,
  connection: number | null | undefined,
  version: string | null | undefined,
  org: number | null | undefined,
  template: number | null | undefined,
  now: number,
  env: object,
  release: Release | null | undefined,
): Promise<ActionPassFence | null> {
  const prepared = prepareActionPassFence(
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
    release?.templateSnapshot?.raw,
  );
  return prepared
    ? prepared.complete(await prepared.statement.first<{ rules: string | null }>())
    : null;
}
