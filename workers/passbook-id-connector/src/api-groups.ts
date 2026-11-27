import { assertNotFrozen } from './freeze.ts';
import { readUser } from './groups.ts';
import { alert, ctxMeta, meta, noteCall } from './ledger.ts';
import { failure, ok } from './pocket-http.ts';
import {
  assertCtx,
  assertEmail,
  assertId,
  assertSpec,
  assertTokenIds,
  ID,
  mappedIds,
  refuse,
  sameSet,
  signupBody,
} from './policy.ts';
import { asProved, matchTokens, oldestNeeded, parseAuditPage, sha256Hex } from './proof.ts';
import type { Shared } from './shared.ts';
import { recordProof, rememberSignup, setSignupState, signupsById } from './store.ts';
import { IdpError, type IdpRpc, KIND_ROLES, type Target } from './types.ts';

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const AUDIT_PAGES = 5;
const LIST_PAGES = 5;

type SignupApi = Pick<IdpRpc, 'createSignup' | 'deleteSignup' | 'proveSignup'>;

/** Signup tokens: mint, withdraw, and prove which account a token created. */
export function signupApi(s: Shared): SignupApi {
  const { db, deps, r, call, gate, env } = s;

  return {
    async createSignup(spec, ctx) {
      const c = await call.guard(meta('createSignup'), () => assertCtx(ctx));
      const m = ctxMeta('createSignup', c);
      const sp = await call.guard(m, () => assertSpec(spec));
      const targets: Target[] = [
        ...KIND_ROLES[sp.kind],
        ...sp.groups.map((g) => `g:${g}` as const),
      ];
      const mm = { ...m, role: targets.join(','), delta: 'signup' };
      // A role the config lists without an id may be placed by now: only the composed registry can tell.
      const peeked = gate.peek();
      if (peeked)
        await call.guard(mm, () =>
          mappedIds(
            targets.filter(
              (t) => !t.startsWith('g:') && !peeked.unplaced.some((u) => u.role === t),
            ),
            peeked,
          ),
        );
      const { registry } = await gate.requireWrite(mm);
      const groupIds = await call.guard(mm, () => mappedIds(targets, registry, true));
      return call.ledgered(c.dryRun ? 'preview' : 'createSignup', mm, async (req) => {
        if (s.dry(c.dryRun)) {
          await noteCall(db, 'dry_run', mm, deps.now(), 'dry_run');
          return { dryRun: true as const };
        }
        const res = await req('POST', r.signupTokens, signupBody(groupIds));
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
          throw new IdpError('IDP_UPSTREAM', 'Polaris ID returned an unexpected signup token.');
        // Polaris ID drops unknown group ids silently: the groups read back must be exactly the request.
        const groups = (t?.userGroups ?? []).map((g) => str(g?.id) ?? '');
        if (t?.usageLimit !== 1 || !sameSet(groups, groupIds)) {
          await req('DELETE', r.signupToken(tokenId));
          alert('error', 'binding.drift', { tokenId });
          throw new IdpError('IDP_DRIFT', 'The signup token did not carry the expected groups.');
        }
        const createdAt = deps.now();
        const expiresAt = Date.parse(str(t?.expiresAt) ?? '');
        // A token that lives past an hour, or says nothing about its end, is withdrawn.
        if (Number.isNaN(expiresAt) || expiresAt > createdAt + 3_660_000) {
          await req('DELETE', r.signupToken(tokenId));
          alert('error', 'binding.drift', { tokenId });
          throw new IdpError('IDP_DRIFT', 'The signup token did not expire as expected.');
        }
        await rememberSignup(db, {
          tokenId,
          tokenSha256: await sha256Hex(value),
          kind: sp.kind,
          targets,
          ref: c.ref,
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

    async deleteSignup(tokenId, ctx) {
      const c = await call.guard(meta('deleteSignup'), () => assertCtx(ctx));
      const m = ctxMeta('deleteSignup', c);
      const row = await call.guard(m, async () => {
        const [found] = await signupsById(db, [assertId('token id', tokenId)]);
        return found ?? refuse('Token was not minted here.');
      });
      if (row.state === 'deleted') return 'gone';
      if (row.state === 'used' || row.state === 'proven') return 'used';
      const mm = { ...m, target: row.tokenId };
      // Withdrawing a token is harmless under an unsafe config, so only a freeze stops it.
      await assertNotFrozen(db, mm, deps.now());
      return call.ledgered(c.dryRun ? 'preview' : 'deleteSignup', mm, async (req) => {
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
        const dry = s.dry(c.dryRun);
        if (usage === null) {
          if (!dry) await setSignupState(db, row.tokenId, 'deleted');
          return 'gone';
        }
        if (usage > 0) {
          if (!dry) await setSignupState(db, row.tokenId, 'used');
          return 'used';
        }
        if (dry) {
          await noteCall(db, 'dry_run', mm, deps.now(), 'dry_run');
          return { dryRun: true as const };
        }
        const del = await req('DELETE', r.signupToken(row.tokenId));
        if (del.status !== 404 && !ok(del)) throw failure(del);
        await setSignupState(db, row.tokenId, 'deleted');
        return del.status === 404 ? 'gone' : 'deleted';
      });
    },

    async proveSignup(tokenIds, opts) {
      const { rows, sub, email } = await call.guard(meta('proveSignup'), async () => {
        if (opts !== undefined && (!opts || typeof opts !== 'object' || Array.isArray(opts)))
          refuse('Invalid options.');
        const subject = opts?.subject;
        const ids = assertTokenIds(tokenIds);
        const found = await signupsById(db, ids);
        if (found.length !== ids.length) refuse('Token was not minted here.');
        const who = subject === undefined ? undefined : assertId('subject', subject);
        if (who && found.some((t) => t.state === 'proven' && t.subject !== who))
          refuse('Token is already proven for another account.');
        return {
          rows: found,
          sub: who,
          email: opts?.email === undefined ? undefined : assertEmail(opts.email),
        };
      });
      const m = meta('proveSignup', { target: rows.map((t) => t.tokenId).join(',') });
      const known = rows.filter((t) => t.state === 'proven' && t.subject);
      const open = rows.filter((t) => t.state !== 'proven');
      const matches = known.map((t) => ({ tokenId: t.tokenId, subject: t.subject as string }));
      if (open.length) {
        const created = await call.ledgered('proveSignup', m, async (req) => {
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
        for (const hit of created.filter((x) => !sub || x.subject === sub)) {
          const targets = open.find((t) => t.tokenId === hit.tokenId)?.targets;
          try {
            await recordProof(db, hit.tokenId, hit.subject, targets ?? [], deps.now());
          } catch {
            throw new IdpError('IDP_CONFLICT', 'An account is already proven by another token.');
          }
          matches.push(hit);
        }
      }
      const out = sub ? matches.filter((x) => x.subject === sub) : matches;
      const first = out[0];
      if (!first) return null;
      if (email === undefined) return { ...first, matches: out };
      // The address is compared here and never returned: only whether the proven account uses it, verified.
      const emailMatch = await call.ledgered(
        'lookup',
        meta('proveSignup', { target: first.subject }),
        async (req) => {
          const user = await readUser(req, r, first.subject);
          if (user.emailVerified !== true) return 'unverified' as const;
          return typeof user.email === 'string' && user.email.toLowerCase() === email
            ? ('match' as const)
            : ('mismatch' as const);
        },
      );
      return { ...first, matches: out, emailMatch };
    },
  };
}
