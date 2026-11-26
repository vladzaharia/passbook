import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import type { OrgRole } from '../../../shared/contracts/org-membership.ts';
import { defineOperationKind } from '../../../shared/operations/define.ts';
import { grantKitMembership } from '../passes/apple-release-test-fixtures.ts';
import type { Kit } from '../passes/pass-test-fixtures.ts';
import { makeTenantTestApiKey } from '../passes/repo-tenant-test-fixtures.ts';
import { type OperationRunner, registerOperationKind } from './registry.ts';

const steps = [
  { key: 'a', label: 'First', active: 'Doing the first' },
  { key: 'b', label: 'Second', active: 'Doing the second', counts: true },
  { key: 'c', label: 'Erase', tail: true },
] as const;

const common = {
  stallMs: 120_000,
  title: 'Test run',
  doneTitle: 'Test run done',
  failTitle: 'Could not run',
  steps,
  retry: true,
  stepUp: false,
} as const;

/** Org kind: read `passes:read`, stop and retry `passes:operate`, one active per `k`. */
export const ORG_KIND = defineOperationKind({
  ...common,
  kind: 'test.org',
  audience: 'org',
  read: 'passes:read',
  write: 'passes:operate',
  cancel: 'between-steps',
  dedupe: (s) => `test:${s.k}`,
  errors: { FEATURE_NOT_INCLUDED: 'Not on this plan. Retry.' },
});
export const QUEUED_ONLY_KIND = defineOperationKind({
  ...common,
  kind: 'test.queued',
  audience: 'org',
  read: 'passes:read',
  write: 'passes:operate',
  cancel: 'queued',
});
export const NEVER_KIND = defineOperationKind({
  ...common,
  kind: 'test.never',
  audience: 'org',
  read: 'passes:read',
  write: 'passes:operate',
  cancel: 'never',
});
export const STARTER_KIND = defineOperationKind({
  ...common,
  kind: 'test.starter',
  audience: 'starter',
  read: null,
  write: null,
  cancel: 'queued',
});
export const PLATFORM_KIND = defineOperationKind({
  ...common,
  kind: 'test.platform',
  audience: 'platform',
  read: null,
  write: null,
  cancel: 'between-steps',
});
export const STEP_UP_KIND = defineOperationKind({
  ...common,
  kind: 'test.stepup',
  audience: 'org',
  read: 'passes:read',
  write: 'passes:operate',
  cancel: 'between-steps',
  stepUp: true,
});

/** Declares every test kind; the runner applies to all. Returns what undoes it. */
export function registerTestKinds(
  runner: OperationRunner = { authorizeRetry: async () => {} },
): () => void {
  const undo = [
    ORG_KIND,
    QUEUED_ONLY_KIND,
    NEVER_KIND,
    STARTER_KIND,
    PLATFORM_KIND,
    STEP_UP_KIND,
  ].map((def) => registerOperationKind(def, runner));
  return () => {
    for (const u of undo) u();
  };
}

/** A person with a session, and a membership in the kit org when `roles` is given. */
export async function person(
  kit: Kit,
  roles?: OrgRole[],
  session: ('admin' | 'user')[] = ['user'],
  authTime?: number,
) {
  const user = await makeUser(kit.fx);
  const s = await makeSession(kit.fx, {
    userId: user.id,
    roles: session,
    ...(authTime === undefined ? {} : { authTime }),
  });
  if (roles) await grantKitMembership(kit, kit.org.id, user.id, roles);
  return { userId: user.id, headers: { ...s.headers, origin: 'https://wallet.test' } };
}

export async function keyHeaders(kit: Kit, scopes: string[], orgId: string | null = kit.org.id) {
  return (await makeTenantTestApiKey(kit.fx, { orgId, scopes })).headers;
}
