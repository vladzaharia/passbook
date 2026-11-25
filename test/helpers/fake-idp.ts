import type {
  IdpCall,
  IdpHealth,
  IdpRpc,
  SignupKind,
  Target,
} from '../../src/worker/modules/idp/types.ts';
import { accountMethods } from './fake-idp-accounts.ts';
import { type FakeAccount, groupMethods } from './fake-idp-groups.ts';
import type { FakeIdp, FakeIdpOptions } from './fake-idp-types.ts';

export type { FakeAccount, FakeGroup } from './fake-idp-groups.ts';
export type { FakeIdp, FakeIdpOptions } from './fake-idp-types.ts';

const KIND_ROLES: Record<SignupKind, Target[]> = {
  member: ['console'],
  developer: ['developer'],
  member_developer: ['developer', 'console'],
  platform: [],
};

const refuse = (code: string): never => {
  throw new Error(`${code}: fake binding refusal`);
};

export function createFakeIdp(options: FakeIdpOptions = {}): FakeIdp {
  const now = options.now ?? (() => Date.now());
  const signups: FakeIdp['signups'] = new Map();
  const accounts: FakeIdp['accounts'] = new Map();
  const groups: FakeIdp['groupStore'] = new Map(
    (['console', 'developer'] as const).map((role) => [
      role,
      { kind: 'role', name: `passbook_${role}`, friendlyName: `passbook_${role}`, otherClients: 0 },
    ]),
  );
  for (const [key, name] of Object.entries(options.adopt ?? {}))
    groups.set(key, { kind: 'adopted', name, friendlyName: name, otherClients: 0 });
  const proofs = new Map<string, string>();
  const calls: IdpCall[] = [];
  const log: string[] = [];
  const failures: { code: string; method: string }[] = [];
  const spent = new Map<string, number>();
  let removals = 0;
  let n = 0;

  const record = (
    method: string,
    phase: string,
    status: string | null,
    target: string | null = null,
    bucket: string | null = null,
  ): void => {
    calls.push({
      id: calls.length + 1,
      callId: `call-${calls.length + 1}`,
      phase,
      method,
      bucket,
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

  let current = '';
  const enter = (method: string, write = false): void => {
    log.push(method);
    current = method;
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
  };

  /** The binding never writes to admins, platform-admin members, the key user or `me`. */
  /** `holdLease('g:crew')` or a subject: the next write that needs it answers `IDP_CONFLICT`. */
  const leases = new Set<string>();
  const lease = (key: string): void => {
    if (leases.has(key)) refuse('IDP_CONFLICT');
  };
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
  /** A dry run computes and ledgers the write in the `preview` bucket; it sends nothing. */
  const dry = (flag: boolean | undefined, bucket: string): boolean => {
    const isDry = flag === true || idp.mode !== 'live';
    const charged = isDry ? 'preview' : bucket;
    const count = (spent.get(charged) ?? 0) + 1;
    spent.set(charged, count);
    const limit = options.budget?.[charged];
    if (limit !== undefined && count > limit) {
      record(current, 'budget', 'IDP_BUDGET', null, charged);
      refuse('IDP_BUDGET');
    }
    if (isDry) record(current, 'dry_run', 'preview', null, 'preview');
    return isDry;
  };
  const removal = (): void => {
    removals += 1;
    if (options.breaker !== undefined && removals > options.breaker) {
      record(current, 'refused', 'IDP_BREAKER');
      refuse('IDP_BREAKER');
    }
  };
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
  const disabledByUs = new Set<string>();
  const groupEnv = {
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
    lease,
    removal,
  };
  const groupsApi = groupMethods(groupEnv);
  const accountsApi = accountMethods({
    ...groupEnv,
    disabledByUs,
    assertTargets: groupsApi.assertTargets,
    isAdopted: (t) => groups.get(t.replace(/^g:/, ''))?.kind === 'adopted' && t.startsWith('g:'),
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
    holdLease: (key) => void leases.add(key),
    setGroupState: (key, state) => {
      const g = groups.get(key);
      if (!g) throw new Error(`No group ${key}`);
      Object.assign(g, state);
    },
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
    ...accountsApi,
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
        blocked: groupsApi.blockedTargets(),
        groups: {
          console: 'passbook_console',
          developer:
            options.developerGroup === undefined ? 'passbook_developers' : options.developerGroup,
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
      if (dry(ctx.dryRun, 'createSignup')) return { dryRun: true };
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
      if (dry(ctx.dryRun, 'deleteSignup')) return { dryRun: true };
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

/** Gives a test env the `IDP` binding, backed by the fake. */
export function installFakeIdp(env: object, idp: FakeIdp): void {
  Object.assign(env, { IDP: idp.binding });
}
