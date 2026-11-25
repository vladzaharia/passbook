import type {
  IdpCall,
  IdpHealth,
  IdpRpc,
  IdpSignup,
} from '../../src/worker/modules/dev-access/idp-types.ts';

export interface FakeIdp extends IdpRpc {
  /** The `IDP` binding for a test env. */
  binding: IdpRpc;
  /** Signup tokens minted and not deleted, by id. */
  signups: Map<string, IdpSignup & { ref: string; used: boolean }>;
  /** Subjects holding the developers group, with how they got it. */
  grants: Map<string, 'signup' | 'added'>;
  /** Method names called, in order. */
  log: string[];
  /** Makes the next call to `method` (or any call with `*`) fail as the provisioner does: `CODE: text`. */
  failNext(code: string, method?: string): void;
  /** The person finished signup with this token: `proveSignup` now finds them. */
  completeSignup(tokenId: string, subject: string): void;
}

export function createFakeIdp(options: { groupName?: string; now?: () => number } = {}): FakeIdp {
  const now = options.now ?? (() => Date.now());
  const signups: FakeIdp['signups'] = new Map();
  const grants: FakeIdp['grants'] = new Map();
  const subjects = new Map<string, string>();
  const calls: IdpCall[] = [];
  const log: string[] = [];
  const failures: { code: string; method: string }[] = [];
  let n = 0;

  const enter = (method: string): void => {
    log.push(method);
    const at = failures.findIndex((f) => f.method === method || f.method === '*');
    if (at < 0) return;
    const [failure] = failures.splice(at, 1);
    calls.push({ at: now(), method, phase: 'refused', ref: null, code: failure?.code ?? null });
    throw new Error(`${failure?.code}: fake provisioner failure`);
  };

  const idp: FakeIdp = {
    binding: undefined as unknown as IdpRpc,
    signups,
    grants,
    log,
    failNext: (code, method = '*') => void failures.push({ code, method }),
    completeSignup: (tokenId, subject) => {
      const s = signups.get(tokenId);
      if (!s) throw new Error(`No signup ${tokenId}`);
      s.used = true;
      subjects.set(tokenId, subject);
    },
    async health(): Promise<IdpHealth> {
      enter('health');
      return {
        groupName: options.groupName ?? 'passbook_developers',
        unsafe: [],
        keyExpiresAt: null,
        layout: 'v2',
      };
    },
    async createSignup(ref) {
      enter('createSignup');
      const tokenId = `tok-${++n}`;
      const signup = {
        tokenId,
        url: `https://id.test/st/secret-${n}`,
        expiresAt: now() + 3_600_000,
      };
      signups.set(tokenId, { ...signup, ref, used: false });
      return signup;
    },
    async deleteSignup(tokenId) {
      enter('deleteSignup');
      const s = signups.get(tokenId);
      if (!s) return 'gone';
      if (s.used) return 'used';
      signups.delete(tokenId);
      return 'deleted';
    },
    async proveSignup(tokenIds, subject) {
      enter('proveSignup');
      for (const tokenId of tokenIds) {
        const found = subjects.get(tokenId);
        if (!found || (subject !== undefined && subject !== found)) continue;
        grants.set(found, 'signup');
        return { tokenId, subject: found };
      }
      return null;
    },
    async addDeveloper(subject) {
      enter('addDeveloper');
      if (grants.has(subject)) return 'already';
      grants.set(subject, 'added');
      return 'added';
    },
    async removeDeveloper(subject) {
      enter('removeDeveloper');
      if (!grants.delete(subject)) return 'not_ours';
      return 'removed';
    },
    async calls(since) {
      enter('calls');
      return calls.filter((c) => c.at >= since);
    },
  };
  idp.binding = idp;
  return idp;
}
