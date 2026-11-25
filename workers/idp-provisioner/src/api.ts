import { createCall } from './call.ts';
import { assertEditable, readAccount, writeGroups } from './groups.ts';
import { probe } from './health.ts';
import { alert, dayCount, LIMITS, logRefusal, readCalls } from './ledger.ts';
import { type Deps, failure, ok } from './pocket-http.ts';
import {
  assertId,
  assertReason,
  assertTokenIds,
  envReasons,
  HEALTH_TTL,
  ID,
  refuse,
  sameSet,
  signupBody,
  UNSAFE_TTL,
} from './policy.ts';
import { asProved, matchTokens, oldestNeeded, parseAuditPage, sha256Hex } from './proof.ts';
import { routes } from './routes.ts';
import {
  endGrant,
  liveGrant,
  readHealth,
  recordAdded,
  recordProof,
  rememberSignup,
  setSignupState,
  signupsById,
  writeHealth,
} from './store.ts';
import { BUDGETED, type Health, IdpError, type IdpRpc, type ProvisionerEnv } from './types.ts';

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const AUDIT_PAGES = 5;
const LIST_PAGES = 5;

/** The provisioner's RPC methods over injectable I/O. The entrypoint class only delegates here. */
export function createApi(env: ProvisionerEnv, deps: Deps): IdpRpc {
  const db = env.DB;
  const gid = env.DEVELOPER_GROUP_ID;
  const r = routes(env.POCKET_ID_API === 'admin' ? 'admin' : 'v2');
  const { guard, ledgered } = createCall(env, deps);

  /** The cached health read; a stale or unsafe one is read again. Settings errors short-circuit without a request. */
  async function currentHealth(force = false) {
    const own = envReasons(env);
    if (own.length)
      return {
        checkedAt: deps.now(),
        unsafe: own,
        groupName: null,
        keyExpiresAt: null,
        layoutSuspect: false,
      };
    const cached = await readHealth(db);
    const ttl = cached?.unsafe.length ? UNSAFE_TTL : HEALTH_TTL;
    if (!force && cached && deps.now() - cached.checkedAt < ttl) return cached;
    const fresh = {
      ...(await ledgered('health', null, undefined, (req) => probe(env, r, req))),
      checkedAt: deps.now(),
    };
    await writeHealth(db, fresh);
    return fresh;
  }

  /** Every group write passes here first: unsafe settings mean no write at all. */
  async function requireSafe(method: string, target: string | null, caller: string): Promise<void> {
    const h = await currentHealth();
    if (!h.unsafe.length) return;
    await logRefusal(db, method, target, caller, deps.now(), 'IDP_UNSAFE_CONFIG');
    alert('error', 'provisioner.unsafe_config', { method, reasons: h.unsafe });
    throw new IdpError(
      'IDP_UNSAFE_CONFIG',
      `Unsafe Pocket ID configuration: ${h.unsafe.join(', ')}.`,
    );
  }

  return {
    async health(): Promise<Health> {
      const h = await currentHealth();
      const budget: Health['budget'] = {};
      for (const m of BUDGETED)
        budget[m] = { day: await dayCount(db, m, deps.now()), limit: LIMITS[m].perDay };
      return { ...h, ok: h.unsafe.length === 0, layout: env.POCKET_ID_API, budget };
    },

    async createSignup(ref) {
      const who = await guard('createSignup', null, undefined, () => assertId('ref', ref));
      await requireSafe('createSignup', null, who);
      return ledgered('createSignup', null, who, async (req) => {
        const res = await req('POST', r.signupTokens, signupBody(env));
        if (!ok(res)) throw failure(res);
        const t = res.body as {
          id?: unknown;
          token?: unknown;
          expiresAt?: unknown;
          usageLimit?: unknown;
          userGroups?: { id?: unknown }[];
        } | null;
        const tokenId = str(t?.id);
        const value = str(t?.token);
        if (!tokenId || !ID.test(tokenId) || !value)
          throw new IdpError('IDP_UPSTREAM', 'Pocket ID returned an unexpected signup token.');
        // Read back what was minted: exactly one use and exactly the developers group, or it is withdrawn.
        const groups = (t?.userGroups ?? []).map((g) => str(g?.id) ?? '');
        if (t?.usageLimit !== 1 || !sameSet(groups, [gid])) {
          await req('DELETE', r.signupToken(tokenId));
          alert('error', 'provisioner.drift', { tokenId });
          throw new IdpError('IDP_DRIFT', 'The signup token did not carry the expected group.');
        }
        const createdAt = deps.now();
        const parsed = Date.parse(str(t?.expiresAt) ?? '');
        const expiresAt = Number.isNaN(parsed) ? createdAt + 3_600_000 : parsed;
        await rememberSignup(db, {
          tokenId,
          tokenSha256: await sha256Hex(value),
          ref: who,
          createdAt,
          expiresAt,
        });
        return {
          tokenId,
          url: `${env.POCKET_ID_ORIGIN}/st/${encodeURIComponent(value)}`,
          expiresAt,
        };
      });
    },

    async deleteSignup(tokenId) {
      const row = await guard('deleteSignup', null, undefined, async () => {
        const [found] = await signupsById(db, [assertId('token id', tokenId)]);
        return found ?? refuse('Token was not minted here.');
      });
      if (row.state === 'deleted') return 'gone';
      if (row.state === 'used' || row.state === 'proven') return 'used';
      return ledgered('deleteSignup', row.tokenId, undefined, async (req) => {
        let usage: number | null = null;
        for (let page = 1; page <= LIST_PAGES && usage === null; page++) {
          const res = await req(
            'GET',
            `${r.signupTokens}?pagination[limit]=100&pagination[page]=${page}`,
          );
          if (!ok(res)) throw failure(res);
          const items =
            (res.body as { data?: { id?: unknown; usageCount?: unknown }[] } | null)?.data ?? [];
          const mine = items.find((i) => i?.id === row.tokenId);
          if (mine) usage = typeof mine.usageCount === 'number' ? mine.usageCount : 1;
          else if (items.length < 100) break;
        }
        if (usage === null) {
          await setSignupState(db, row.tokenId, 'deleted');
          return 'gone';
        }
        if (usage > 0) {
          await setSignupState(db, row.tokenId, 'used');
          return 'used';
        }
        const del = await req('DELETE', r.signupToken(row.tokenId));
        if (del.status !== 404 && !ok(del)) throw failure(del);
        await setSignupState(db, row.tokenId, 'deleted');
        return del.status === 404 ? 'gone' : 'deleted';
      });
    },

    async proveSignup(tokenIds, subject) {
      const { rows, sub } = await guard('proveSignup', null, undefined, async () => {
        const ids = assertTokenIds(tokenIds);
        const found = await signupsById(db, ids);
        if (found.length !== ids.length) refuse('Token was not minted here.');
        const who = subject === undefined ? undefined : assertId('subject', subject);
        if (who && found.some((t) => t.state === 'proven' && t.subject !== who))
          refuse('Token is already proven for another account.');
        return { rows: found, sub: who };
      });
      const target = rows.map((t) => t.tokenId).join(',');
      const known = rows.filter((t) => t.state === 'proven' && t.subject);
      const open = rows.filter((t) => t.state !== 'proven');
      const matches = known.map((t) => ({ tokenId: t.tokenId, subject: t.subject as string }));
      if (open.length) {
        const created = await ledgered('proveSignup', target, undefined, async (req) => {
          const seen = [];
          for (let page = 1; page <= AUDIT_PAGES; page++) {
            const res = await req('GET', r.auditLogs(page));
            if (!ok(res)) throw failure(res);
            const parsed = parseAuditPage(res.body);
            seen.push(...parsed.rows);
            const oldest = parsed.rows.at(-1)?.createdAt;
            if (page >= parsed.totalPages || (oldest !== undefined && oldest < oldestNeeded(open)))
              break;
          }
          return asProved(await matchTokens(seen, open));
        });
        for (const m of created.filter((c) => !sub || c.subject === sub)) {
          try {
            await recordProof(db, m.tokenId, m.subject, deps.now());
          } catch {
            throw new IdpError('IDP_CONFLICT', 'An account is already proven by another token.');
          }
          matches.push(m);
        }
      }
      const out = sub ? matches.filter((m) => m.subject === sub) : matches;
      const first = out[0];
      return first ? { ...first, matches: out } : null;
    },

    async addDeveloper(subject, ref) {
      const { sub, who } = await guard('addDeveloper', null, undefined, () => ({
        sub: assertId('subject', subject),
        who: assertId('ref', ref),
      }));
      await requireSafe('addDeveloper', sub, who);
      return ledgered('addDeveloper', sub, who, async (req) => {
        const account = await readAccount(req, r, sub);
        assertEditable(account, false);
        if (account.groups.includes(gid)) return 'already';
        // Recorded before the write: a lost answer must not leave a group PassBook cannot take back.
        await recordAdded(db, sub, deps.now());
        await writeGroups(req, r, sub, account.groups, gid, true);
        return 'added';
      });
    },

    async removeDeveloper(subject, reason) {
      const { sub, why } = await guard('removeDeveloper', null, undefined, () => ({
        sub: assertId('subject', subject),
        why: assertReason(reason),
      }));
      if (!(await liveGrant(db, sub))) {
        await logRefusal(db, 'removeDeveloper', sub, why, deps.now(), 'not_ours');
        return 'not_ours';
      }
      await requireSafe('removeDeveloper', sub, why);
      return ledgered('removeDeveloper', sub, why, async (req) => {
        let account: Awaited<ReturnType<typeof readAccount>>;
        try {
          account = await readAccount(req, r, sub);
        } catch (error) {
          if (error instanceof IdpError && error.code === 'IDP_NOT_FOUND') {
            await endGrant(db, sub, deps.now());
            return 'absent';
          }
          throw error;
        }
        assertEditable(account, true);
        if (!account.groups.includes(gid)) {
          await endGrant(db, sub, deps.now());
          return 'absent';
        }
        await writeGroups(req, r, sub, account.groups, gid, false);
        await endGrant(db, sub, deps.now());
        return 'removed';
      });
    },

    calls: (since) => readCalls(db, since),
  };
}
