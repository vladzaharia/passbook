import { claim } from './breaker.ts';
import { assertEditable, readAccount, readGroups, readUser, writeGroups } from './groups.ts';
import { ctxMeta, logRefusal, meta, noteCall } from './ledger.ts';
import { assertCtx, assertDelta, assertSubject, mappedIds, refuse } from './policy.ts';
import type { Shared } from './shared.ts';
import {
  disabledByBinding,
  endGrants,
  liveGrants,
  markDisabled,
  recordAdded,
  recordOverride,
  subjectClass,
} from './store.ts';
import {
  type ApplyResult,
  type Bucket,
  IdpError,
  type IdpRpc,
  WRITABLE_ROLES,
  type WritableRole,
} from './types.ts';
import { putDisabled } from './user-put.ts';

type AccountsApi = Pick<IdpRpc, 'lookup' | 'apply' | 'setDisabled'>;

/** Reads and changes of one account's roles and disabled flag. */
export function accountsApi(s: Shared): AccountsApi {
  const { db, deps, r, call, gate } = s;

  return {
    async lookup(subject) {
      const m0 = meta('lookup');
      const sub = await call.guard(m0, () => assertSubject(subject));
      const registry = gate.readable();
      const m = meta('lookup', { target: sub });
      return call.ledgered('lookup', m, async (req) => {
        const account = await readAccount(req, r, sub);
        const roles = registry.entries
          .filter((e) => account.groups.includes(e.id))
          .map((e) => e.role);
        const grants = await liveGrants(db, sub);
        return {
          roles,
          disabled: account.disabled,
          isAdmin: account.isAdmin,
          class: (await subjectClass(db, sub)) ?? 'external',
          grants: WRITABLE_ROLES.filter((role) => grants.includes(role)),
        };
      });
    },

    async apply(subject, delta, ctx) {
      const c = await call.guard(meta('apply'), () => assertCtx(ctx));
      const m0 = ctxMeta('apply', c);
      const { sub, change } = await call.guard(m0, () => {
        const parsed = assertDelta(delta);
        if (c.override && (!parsed.remove.length || parsed.add.length))
          refuse('An override is a removal.');
        return { sub: assertSubject(subject), change: parsed };
      });
      const label = [...change.add.map((x) => `+${x}`), ...change.remove.map((x) => `-${x}`)];
      const m = {
        ...m0,
        target: sub,
        role: [...change.add, ...change.remove].join(','),
        delta: c.override ? 'override' : label.join(','),
      };
      // A role the registry does not map is refused before any Polaris ID read.
      const peeked = gate.peek();
      if (peeked) await call.guard(m, () => mappedIds([...change.add, ...change.remove], peeked));
      const { registry, keySubject } = await gate.requireWrite(m);

      // Roles PassBook did not add are left alone without a call, unless an override says otherwise.
      const ours = await liveGrants(db, sub);
      const skipped: ApplyResult['skipped'] = [];
      const remove = change.remove.filter((role) => {
        if (c.override || ours.includes(role)) return true;
        skipped.push({ role, reason: 'not_ours' });
        return false;
      });
      if (skipped.length) await logRefusal(db, m, deps.now(), 'not_ours');
      if (!change.add.length && !remove.length)
        return { added: [], removed: [], skipped, dryRun: false };

      const buckets: Bucket[] = [];
      if (change.add.length) buckets.push(c.system ? 'apply_add_system' : 'apply_add');
      if (remove.length) buckets.push(c.override ? 'apply_override' : 'apply_remove');
      const dry = s.dry(c.dryRun);

      return call.ledgered(buckets, m, async (req) => {
        const account = await readAccount(req, r, sub);
        assertEditable(account, sub, registry, keySubject, change.add.length > 0);
        const idOf = (role: WritableRole) => registry.writableId(role) as string;
        const added: WritableRole[] = [];
        const removed: WritableRole[] = [];
        for (const role of change.add) {
          if (account.groups.includes(idOf(role))) skipped.push({ role, reason: 'already' });
          else added.push(role);
        }
        const spent: WritableRole[] = [];
        for (const role of remove) {
          if (account.groups.includes(idOf(role))) removed.push(role);
          else {
            spent.push(role);
            skipped.push({ role, reason: 'absent' });
          }
        }
        const result = (): ApplyResult => ({ added, removed, skipped, dryRun: dry });
        if (!dry && spent.length) await endGrants(db, sub, spent, 'idp_absent', deps.now());
        if (!added.length && !removed.length) return result();
        await claim(db, m, { removals: removed.length }, deps.now());
        if (dry) {
          await noteCall(db, 'dry_run', m, deps.now(), 'dry_run');
          return result();
        }
        if (added.length) await recordAdded(db, sub, added, c.ref, deps.now());
        await writeGroups(req, r, sub, account.groups, added.map(idOf), removed.map(idOf));
        const withGrant = removed.filter((role) => ours.includes(role));
        if (withGrant.length) await endGrants(db, sub, withGrant, c.reason, deps.now());
        const overridden = removed.filter((role) => !ours.includes(role));
        if (overridden.length) await recordOverride(db, sub, overridden, c.ref, deps.now());
        return result();
      });
    },

    async setDisabled(subject, disabled, ctx) {
      const c = await call.guard(meta('setDisabled'), () => assertCtx(ctx));
      const m0 = ctxMeta('setDisabled', c);
      const sub = await call.guard(m0, () => {
        if (typeof disabled !== 'boolean') refuse('Invalid disabled flag.');
        return assertSubject(subject);
      });
      const m = { ...m0, target: sub, delta: disabled ? 'disable' : 'enable' };
      const { registry, keySubject } = await gate.requireWrite(m);
      const klass = await subjectClass(db, sub);
      if (klass !== 'created' || (!disabled && !(await disabledByBinding(db, sub)))) {
        await logRefusal(db, m, deps.now(), 'IDP_NOT_MANAGED');
        throw new IdpError('IDP_NOT_MANAGED', 'PassBook does not manage this Polaris ID account.');
      }
      return call.ledgered('setDisabled', m, async (req) => {
        const user = await readUser(req, r, sub);
        const groups = await readGroups(req, r, sub);
        assertEditable(
          { isAdmin: user.isAdmin, disabled: false, groups },
          sub,
          registry,
          keySubject,
          false,
        );
        // An account with a group outside the registry belongs to someone else's access too.
        if (groups.some((g) => !registry.ids.includes(g)))
          throw new IdpError(
            'IDP_NOT_MANAGED',
            'PassBook does not manage this Polaris ID account.',
          );
        if (user.disabled === disabled) return { result: 'already' as const, dryRun: false };
        const dry = s.dry(c.dryRun);
        await claim(db, m, { disables: disabled ? 1 : 0 }, deps.now());
        if (dry) {
          await noteCall(db, 'dry_run', m, deps.now(), 'dry_run');
          return { result: disabled ? ('disabled' as const) : ('enabled' as const), dryRun: true };
        }
        await putDisabled(req, r, sub, user, disabled);
        await markDisabled(db, sub, disabled ? deps.now() : null);
        return { result: disabled ? ('disabled' as const) : ('enabled' as const), dryRun: false };
      });
    },
  };
}
