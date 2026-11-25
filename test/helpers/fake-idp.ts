import type {
  ApplyResult,
  IdpCall,
  IdpHealth,
  IdpLookup,
  IdpRpc,
  IdpSignup,
  IdpSnapshot,
  Role,
  SignupKind,
  SnapshotMember,
  Target,
} from '../../src/worker/modules/idp/types.ts';
import { type FakeAccount, type FakeGroup, groupMethods } from './fake-idp-groups.ts';

export type { FakeAccount, FakeGroup } from './fake-idp-groups.ts';

const KIND_ROLES: Record<SignupKind, Target[]> = {
  member: ['console'],
  developer: ['developer'],
  member_developer: ['developer', 'console'],
  platform: [],
};

export interface FakeIdp extends IdpRpc {
  /** The `IDP` binding for a test env. */
  binding: IdpRpc;
  /** Signup tokens minted and not deleted, by id. */
  signups: Map<
    string,
    IdpSignup & { kind: SignupKind; targets: Target[]; ref: string; used: boolean }
  >;
  /** Role groups (seeded: console, developer), custom and adopted groups, by role or key. */
  groupStore: Map<string, FakeGroup>;
  accounts: Map<string, FakeAccount>;
  /** Method names called, in order. */
  log: string[];
  /** Writes the binding would have sent to Polaris ID. Dry runs and refusals add none. */
  writes: number;
  frozen: boolean;
  mode: 'dry_run' | 'live';
  /** Makes the next call to `method` (or any call with `*`) fail as the binding does: `CODE: text`. */
  failNext(code: string, method?: string): void;
  /** The person finished signup with this token: `proveSignup` now finds them. */
  completeSignup(
    tokenId: string,
    subject: string,
    account?: { email?: string; emailVerified?: boolean },
  ): void;
  /** Seeds an account that already exists in Polaris ID. */
  addAccount(
    subject: string,
    init?: Partial<Omit<FakeAccount, 'roles' | 'grants'>> & { roles?: (Role | `g:${string}`)[] },
  ): void;
}

const refuse = (code: string): never => {
  throw new Error(`${code}: fake binding refusal`);
};

export function createFakeIdp(
  options: {
    now?: () => number;
    mode?: 'dry_run' | 'live';
    /** The key owner's subject: never writable. */
    keyUser?: string;
    /** Write calls allowed before `IDP_BUDGET`. */
    budget?: number;
    /** Write calls allowed before the breaker answers `IDP_BREAKER`. */
    breaker?: number;
    /** `CLAIM_KEYS`: exact claim keys outside `passbook_*`. */
    claimKeys?: string[];
    /** `CUSTOM_GROUP_LIMIT`. */
    customLimit?: number;
  } = {},
): FakeIdp {
  const now = options.now ?? (() => Date.now());
  const signups: FakeIdp['signups'] = new Map();
  const accounts: FakeIdp['accounts'] = new Map();
  const groups: FakeIdp['groupStore'] = new Map(
    (['console', 'developer'] as const).map((role) => [
      role,
      { kind: 'role', name: `passbook_${role}`, friendlyName: `passbook_${role}`, otherClients: 0 },
    ]),
  );
  const proofs = new Map<string, string>();
  const calls: IdpCall[] = [];
  const log: string[] = [];
  const failures: { code: string; method: string }[] = [];
  const disabledByUs = new Set<string>();
  let writeCalls = 0;
  let n = 0;

  const record = (
    method: string,
    phase: string,
    status: string | null,
    target: string | null = null,
  ): void => {
    calls.push({
      id: calls.length + 1,
      callId: `call-${calls.length + 1}`,
      phase,
      method,
      bucket: null,
      target,
      caller: null,
      actor: null,
      reason: null,
      role: null,
      delta: null,
      status,
      requestId: null,
      durationMs: 0,
      at: now(),
    });
  };

  const enter = (method: string, write = false): void => {
    log.push(method);
    const at = failures.findIndex((f) => f.method === method || f.method === '*');
    if (at >= 0) {
      const [failure] = failures.splice(at, 1);
      record(method, 'refused', failure?.code ?? null);
      throw new Error(`${failure?.code}: fake binding failure`);
    }
    if (write && idp.frozen) {
      record(method, 'refused', 'IDP_FROZEN');
      refuse('IDP_FROZEN');
    }
    if (!write) return;
    writeCalls += 1;
    if (options.budget !== undefined && writeCalls > options.budget) {
      record(method, 'budget', 'IDP_BUDGET');
      refuse('IDP_BUDGET');
    }
    if (options.breaker !== undefined && writeCalls > options.breaker) {
      record(method, 'refused', 'IDP_BREAKER');
      refuse('IDP_BREAKER');
    }
  };

  /** The binding never writes to admins, platform-admin members, the key user or `me`. */
  const protect = (subject: string, a: FakeAccount): void => {
    if (
      a.isAdmin ||
      a.roles.has('platform_admin') ||
      subject === options.keyUser ||
      subject === 'me'
    )
      refuse('IDP_REFUSED');
  };

  const account = (subject: string): FakeAccount =>
    accounts.get(subject) ?? refuse('IDP_NOT_FOUND');
  const dry = (flag?: boolean): boolean => flag === true || idp.mode !== 'live';
  const write = (): void => {
    idp.writes += 1;
  };

  const newAccount = (): FakeAccount => ({
    class: 'created',
    roles: new Set(),
    grants: new Set(),
    disabled: false,
    isAdmin: false,
    emailVerified: false,
  });
  const groupsApi = groupMethods({
    accounts,
    groups,
    claimKeys: options.claimKeys ?? [],
    customLimit: options.customLimit ?? 50,
    enter,
    dry,
    write,
    refuse,
    account,
    protect,
  });

  const idp: FakeIdp = {
    binding: undefined as unknown as IdpRpc,
    signups,
    accounts,
    groupStore: groups,
    log,
    writes: 0,
    frozen: false,
    mode: options.mode ?? 'live',
    failNext: (code, method = '*') => void failures.push({ code, method }),
    completeSignup: (tokenId, subject, account) => {
      const s = signups.get(tokenId);
      if (!s) throw new Error(`No signup ${tokenId}`);
      s.used = true;
      proofs.set(tokenId, subject);
      if (account) {
        const a = accounts.get(subject) ?? newAccount();
        Object.assign(a, account);
        accounts.set(subject, a);
      }
    },
    ...groupsApi,
    addAccount: (subject, init = {}) => {
      const { roles = [], ...rest } = init;
      accounts.set(subject, {
        class: 'linked',
        disabled: false,
        isAdmin: false,
        emailVerified: false,
        ...rest,
        roles: new Set(roles),
        grants: new Set(),
      });
    },
    async health(): Promise<IdpHealth> {
      enter('health');
      return {
        ok: !idp.frozen,
        unsafe: [],
        warnings: [],
        groups: {
          console: 'passbook_console',
          developer: 'passbook_developers',
          users: 'passbook_users',
        },
        layout: 'v2',
        layoutSuspect: false,
        keyExpiresAt: null,
        checkedAt: now(),
        mode: idp.mode,
        frozen: idp.frozen,
        budget: {},
      };
    },
    async createSignup(spec, ctx) {
      enter('createSignup', true);
      const keys = spec.groups ?? [];
      if (keys.length > 5 || (spec.kind === 'platform' && keys.length === 0)) refuse('IDP_REFUSED');
      const targets: Target[] = [...KIND_ROLES[spec.kind], ...keys.map((k): Target => `g:${k}`)];
      groupsApi.assertTargets(targets);
      if (dry(ctx.dryRun)) return { dryRun: true };
      write();
      const tokenId = `tok-${++n}`;
      const signup = {
        tokenId,
        url: `https://id.test/st/secret-${n}`,
        expiresAt: now() + 3_600_000,
      };
      signups.set(tokenId, { ...signup, kind: spec.kind, targets, ref: ctx.ref, used: false });
      return signup;
    },
    async deleteSignup(tokenId, ctx) {
      enter('deleteSignup', true);
      const s = signups.get(tokenId);
      if (!s) return 'gone';
      if (s.used) return 'used';
      if (dry(ctx.dryRun)) return { dryRun: true };
      write();
      signups.delete(tokenId);
      return 'deleted';
    },
    async proveSignup(tokenIds, opts = {}) {
      enter('proveSignup');
      const matches = [];
      for (const tokenId of tokenIds) {
        const found = proofs.get(tokenId);
        if (!found || (opts.subject !== undefined && opts.subject !== found)) continue;
        const acct = accounts.get(found) ?? newAccount();
        for (const target of signups.get(tokenId)?.targets ?? []) {
          acct.roles.add(target);
          acct.grants.add(target);
        }
        accounts.set(found, acct);
        matches.push({ tokenId, subject: found });
      }
      const first = matches[0];
      if (!first) return null;
      const acct = accounts.get(first.subject);
      const emailMatch =
        opts.email === undefined || !acct
          ? undefined
          : !acct.emailVerified
            ? ('unverified' as const)
            : acct.email === opts.email.trim().toLowerCase()
              ? ('match' as const)
              : ('mismatch' as const);
      return { ...first, matches, ...(emailMatch ? { emailMatch } : {}) };
    },
    async findByVerifiedEmail(email) {
      enter('findByVerifiedEmail');
      const hits = [...accounts].filter(
        ([, a]) =>
          a.email === email.trim().toLowerCase() && a.emailVerified && !a.disabled && !a.isAdmin,
      );
      const hit = hits[0];
      return hits.length === 1 && hit ? { subject: hit[0] } : null;
    },
    async lookup(subject) {
      enter('lookup');
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
      enter('apply', true);
      const a = account(subject);
      protect(subject, a);
      if (a.disabled && delta.add?.length) refuse('IDP_REFUSED');
      groupsApi.assertTargets([...(delta.add ?? []), ...(delta.remove ?? [])]);
      const isDry = dry(ctx.dryRun);
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
        write();
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
      enter('setDisabled', true);
      const a = account(subject);
      if (a.class !== 'created') refuse('IDP_NOT_MANAGED');
      protect(subject, a);
      if (!disabled && a.disabled && !disabledByUs.has(subject)) refuse('IDP_REFUSED');
      if (a.disabled === disabled) return { result: 'already', dryRun: false };
      const isDry = dry(ctx.dryRun);
      if (!isDry) {
        write();
        a.disabled = disabled;
        if (disabled) disabledByUs.add(subject);
        else disabledByUs.delete(subject);
      }
      return { result: disabled ? 'disabled' : 'enabled', dryRun: isDry };
    },
    async snapshot() {
      enter('snapshot', true);
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
    async freeze() {
      enter('freeze');
      if (idp.frozen) return 'already';
      idp.frozen = true;
      return 'frozen';
    },
    async calls(since) {
      enter('calls');
      return calls.filter((c) => c.at >= since);
    },
  };
  idp.binding = idp;
  return idp;
}
