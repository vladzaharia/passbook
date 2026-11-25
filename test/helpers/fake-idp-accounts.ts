import type {
  ApplyResult,
  IdpLookup,
  IdpRpc,
  IdpSnapshot,
  SnapshotMember,
  Target,
} from '../../src/worker/modules/idp/types.ts';
import type { GroupEnv } from './fake-idp-groups.ts';

export interface AccountEnv extends GroupEnv {
  /** Accounts the fake itself disabled; only those may be re-enabled. */
  disabledByUs: Set<string>;
  assertTargets(targets: readonly Target[], adds?: readonly Target[]): void;
  /** Adopted groups are not PassBook's: an account in one is not managed for disable. */
  isAdopted(target: string): boolean;
  /** Grants the owner's removals ended, as the binding's `idp_removed` rows. */
  endedLog: { subject: string; role: Target; at: number }[];
  now(): number;
  isDry(): boolean;
}

export function accountMethods(
  env: AccountEnv,
): Pick<IdpRpc, 'findByVerifiedEmail' | 'lookup' | 'apply' | 'setDisabled' | 'snapshot'> {
  const { accounts, refuse, account, protect, lease } = env;
  return {
    async findByVerifiedEmail(email) {
      env.enter('findByVerifiedEmail');
      const hits = [...accounts].filter(
        ([, a]) =>
          a.email === email.trim().toLowerCase() && a.emailVerified && !a.disabled && !a.isAdmin,
      );
      const hit = hits[0];
      return hits.length === 1 && hit ? { subject: hit[0] } : null;
    },
    async lookup(subject) {
      env.enter('lookup');
      const a = account(subject);
      return {
        roles: [...a.roles] as IdpLookup['roles'],
        disabled: a.disabled,
        isAdmin: a.isAdmin,
        class: a.class,
        grants: [...a.grants] as Target[],
        confirmedGrants: [...a.grants].filter((t) => !a.pending.has(t)) as Target[],
      };
    },
    async apply(subject, delta, ctx) {
      env.enter('apply', true);
      const a = account(subject);
      protect(subject, a);
      lease(`s:${subject}`);
      if (a.disabled && delta.add?.length) refuse('IDP_REFUSED');
      env.assertTargets([...(delta.add ?? []), ...(delta.remove ?? [])], delta.add);
      const system = ctx.actor.kind === 'system';
      const buckets = [
        ...(delta.add?.length
          ? [
              delta.add.some((t) => t.startsWith('g:'))
                ? `apply_add_group${system ? '_system' : ''}`
                : `apply_add${system ? '_system' : ''}`,
            ]
          : []),
        ...(delta.remove?.length ? [ctx.override ? 'apply_override' : 'apply_remove'] : []),
      ];
      let isDry = env.dry(ctx.dryRun, buckets[0] ?? 'apply_add');
      for (const bucket of buckets.slice(1)) isDry = env.dry(ctx.dryRun, bucket) || isDry;
      const result: ApplyResult = { added: [], removed: [], skipped: [], dryRun: isDry };
      for (const role of delta.add ?? []) {
        if (a.roles.has(role)) result.skipped.push({ role, reason: 'already' });
        else result.added.push(role);
      }
      for (const role of delta.remove ?? []) {
        if (!a.roles.has(role)) {
          result.skipped.push({ role, reason: 'absent' });
          // The binding ends a grant for a role that is gone, without a group write.
          if (a.grants.has(role) && !isDry) a.grants.delete(role);
        } else if (!a.grants.has(role) && !ctx.override)
          result.skipped.push({ role, reason: 'not_ours' });
        else result.removed.push(role);
      }
      if (!isDry && (result.added.length || result.removed.length)) {
        for (let i = 0; i < result.removed.length; i++) env.removal();
        env.write();
        for (const role of result.added) {
          a.roles.add(role);
          a.grants.add(role);
        }
        for (const role of result.removed) {
          a.roles.delete(role);
          a.grants.delete(role);
        }
      }
      return result;
    },
    async setDisabled(subject, disabled, ctx) {
      env.enter('setDisabled', true);
      const a = account(subject);
      if (a.class !== 'created' || [...a.roles].some(env.isAdopted)) refuse('IDP_NOT_MANAGED');
      protect(subject, a);
      if (!disabled && a.disabled && !env.disabledByUs.has(subject)) refuse('IDP_NOT_MANAGED');
      if (a.disabled === disabled) return { result: 'already', dryRun: false };
      const isDry = env.dry(ctx.dryRun, 'setDisabled');
      if (!isDry) {
        env.write();
        a.disabled = disabled;
        if (disabled) env.disabledByUs.add(subject);
        else env.disabledByUs.delete(subject);
      }
      return { result: disabled ? 'disabled' : 'enabled', dryRun: isDry };
    },
    async snapshot(ctx) {
      env.enter('snapshot', true);
      // The owner took a role PassBook added: the snapshot ends the grant (unless dry) and reports it since `since`.
      const dryRun = ctx.dryRun === true || env.isDry();
      for (const [subject, a] of accounts)
        for (const role of [...a.grants])
          if (!a.roles.has(role) && !dryRun) {
            a.grants.delete(role);
            env.endedLog.push({ subject, role: role as Target, at: env.now() });
          }
      const ended = env.endedLog
        .filter((e) => e.at >= (ctx.since ?? 0))
        .map(({ subject, role }) => ({ subject, role }));
      const roles: Record<string, { name: string; members: SnapshotMember[] }> = {};
      // Every managed group is listed, empty or not, as the binding's snapshot does.
      for (const [key, g] of env.groups)
        roles[g.kind === 'role' ? key : `g:${key}`] = { name: g.name, members: [] };
      for (const [subject, a] of accounts)
        for (const role of a.roles) {
          const entry = roles[role] ?? { name: role, members: [] };
          roles[role] = entry;
          entry.members.push({
            subject,
            disabled: a.disabled,
            isAdmin: a.isAdmin,
            grant: a.grants.has(role),
          });
        }
      return { roles: roles as IdpSnapshot['roles'], ended };
    },
  };
}
