import type {
  AccountClass,
  ApplyResult,
  IdpCall,
  IdpHealth,
  IdpRpc,
  IdpSignup,
  Role,
  SignupKind,
  WritableRole,
} from '../../src/worker/modules/idp/types.ts';

const KIND_ROLES: Record<SignupKind, WritableRole[]> = {
  member: ['console'],
  developer: ['developer'],
  member_developer: ['developer', 'console'],
};

export interface FakeAccount {
  class: AccountClass;
  roles: Set<Role>;
  /** Roles PassBook added (a live grant); removing any other role needs `override`. */
  grants: Set<WritableRole>;
  disabled: boolean;
  isAdmin: boolean;
  email?: string;
  emailVerified: boolean;
}

export interface FakeIdp extends IdpRpc {
  /** The `IDP` binding for a test env. */
  binding: IdpRpc;
  /** Signup tokens minted and not deleted, by id. */
  signups: Map<string, IdpSignup & { kind: SignupKind; ref: string; used: boolean }>;
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
  completeSignup(tokenId: string, subject: string): void;
  /** Seeds an account that already exists in Polaris ID. */
  addAccount(
    subject: string,
    init?: Partial<Omit<FakeAccount, 'roles' | 'grants'>> & { roles?: Role[] },
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
  } = {},
): FakeIdp {
  const now = options.now ?? (() => Date.now());
  const signups: FakeIdp['signups'] = new Map();
  const accounts: FakeIdp['accounts'] = new Map();
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

  const idp: FakeIdp = {
    binding: undefined as unknown as IdpRpc,
    signups,
    accounts,
    log,
    writes: 0,
    frozen: false,
    mode: options.mode ?? 'live',
    failNext: (code, method = '*') => void failures.push({ code, method }),
    completeSignup: (tokenId, subject) => {
      const s = signups.get(tokenId);
      if (!s) throw new Error(`No signup ${tokenId}`);
      s.used = true;
      proofs.set(tokenId, subject);
    },
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
    async createSignup(kind, ctx) {
      enter('createSignup', true);
      if (dry(ctx.dryRun)) return { dryRun: true };
      write();
      const tokenId = `tok-${++n}`;
      const signup = {
        tokenId,
        url: `https://id.test/st/secret-${n}`,
        expiresAt: now() + 3_600_000,
      };
      signups.set(tokenId, { ...signup, kind, ref: ctx.ref, used: false });
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
    async proveSignup(tokenIds, subject) {
      enter('proveSignup');
      const matches = [];
      for (const tokenId of tokenIds) {
        const found = proofs.get(tokenId);
        if (!found || (subject !== undefined && subject !== found)) continue;
        const kind = signups.get(tokenId)?.kind ?? 'member';
        const roles = KIND_ROLES[kind];
        const acct = accounts.get(found) ?? {
          class: 'created' as const,
          roles: new Set<Role>(),
          grants: new Set<WritableRole>(),
          disabled: false,
          isAdmin: false,
          emailVerified: false,
        };
        for (const role of roles) {
          acct.roles.add(role);
          acct.grants.add(role);
        }
        accounts.set(found, acct);
        matches.push({ tokenId, subject: found });
      }
      const first = matches[0];
      return first ? { ...first, matches } : null;
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
        roles: [...a.roles],
        disabled: a.disabled,
        isAdmin: a.isAdmin,
        class: a.class,
        grants: [...a.grants],
      };
    },
    async apply(subject, delta, ctx) {
      enter('apply', true);
      const a = account(subject);
      protect(subject, a);
      if (a.disabled && delta.add?.length) refuse('IDP_REFUSED');
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
      const roles: Awaited<ReturnType<IdpRpc['snapshot']>>['roles'] = {};
      for (const [subject, a] of accounts)
        for (const role of a.roles) {
          const entry = roles[role] ?? { name: role, members: [] };
          roles[role] = entry;
          entry.members.push({
            subject,
            disabled: a.disabled,
            isAdmin: a.isAdmin,
            grant: a.grants.has(role as WritableRole),
          });
        }
      return { roles, ended: [] };
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
