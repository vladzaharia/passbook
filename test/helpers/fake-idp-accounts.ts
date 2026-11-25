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
  assertTargets(targets: readonly Target[]): void;
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
      };
    },
    async apply(subject, delta, ctx) {
      env.enter('apply', true);
      const a = account(subject);
      protect(subject, a);
      lease(subject);
      if (a.disabled && delta.add?.length) refuse('IDP_REFUSED');
      env.assertTargets([...(delta.add ?? []), ...(delta.remove ?? [])]);
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
        if (!a.roles.has(role)) result.skipped.push({ role, reason: 'absent' });
        else if (!a.grants.has(role) && !ctx.override)
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
      if (a.class !== 'created') refuse('IDP_NOT_MANAGED');
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
    async snapshot() {
      env.enter('snapshot', true);
      const roles: Record<string, { name: string; members: SnapshotMember[] }> = {};
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
      return { roles: roles as IdpSnapshot['roles'], ended: [] };
    },
  };
}
