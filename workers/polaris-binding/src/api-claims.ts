import { assertChanges, decode, keyKind, merge, parseClaims, sameClaims } from './claims.ts';
import { alert, ctxMeta, meta, noteCall } from './ledger.ts';
import { withLock } from './lock.ts';
import { failure, ok, type Req } from './pocket-http.ts';
import { assertCtx, assertSubject, assertTarget, refuse } from './policy.ts';
import type { Registry } from './registry.ts';
import type { Shared } from './shared.ts';
import { subjectClass } from './store.ts';
import { type Bucket, type ClaimView, IdpError, type IdpRpc } from './types.ts';

type ClaimsApi = Pick<IdpRpc, 'claims' | 'setClaims'>;

const unexpected = (what: string) =>
  new IdpError('IDP_UPSTREAM', `Polaris ID returned an unexpected ${what}.`);

type Resolved = { kind: 'subject'; subject: string } | { kind: 'group'; target: string };

/** The owner of a claim set: an account by subject, or a managed group by target. No ids, no names. */
function assertOwner(value: unknown): Resolved {
  const v = value as { subject?: unknown; group?: unknown } | null;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return refuse('Invalid claim owner.');
  if ((v.subject === undefined) === (v.group === undefined)) return refuse('Invalid claim owner.');
  if (v.subject !== undefined) return { kind: 'subject', subject: assertSubject(v.subject) };
  return { kind: 'group', target: assertTarget(v.group) };
}

/** Claims on accounts: never a Polaris ID admin, an admin group member, the key user, or an account the binding does not know. */
export function assertClaimable(
  dto: Record<string, unknown>,
  subject: string,
  registry: Registry,
  keySubject: string | null,
): void {
  const groups = dto.userGroups;
  if (dto.id !== subject || typeof dto.isAdmin !== 'boolean' || !Array.isArray(groups))
    throw unexpected('user');
  const ids = groups.map((g) => {
    const id = (g as { id?: unknown } | null)?.id;
    if (typeof id !== 'string') throw unexpected('user');
    return id;
  });
  if (dto.isAdmin || subject === keySubject || ids.some((id) => registry.adminIds.includes(id)))
    refuse('Claims on this account cannot be changed here.');
}

/** Claim reads and writes. Values are never stored, ledgered or logged: key names and lengths only. */
export function claimsApi(s: Shared): ClaimsApi {
  const { db, deps, r, call, gate } = s;

  async function load(req: Req, owner: Resolved, registry: Registry) {
    if (owner.kind === 'subject') {
      const res = await req('GET', r.user(owner.subject));
      if (!ok(res)) throw failure(res);
      return {
        body: res.body as Record<string, unknown>,
        put: r.userClaims(owner.subject),
        read: r.user(owner.subject),
      };
    }
    const id = registry.targetId(owner.target) ?? refuse('Group is not managed.');
    const res = await req('GET', r.group(id));
    if (!ok(res)) throw failure(res);
    const name = (res.body as { name?: unknown } | null)?.name;
    const expected = owner.target.startsWith('g:')
      ? registry.custom.find((c) => `g:${c.key}` === owner.target)?.name
      : registry.entry(owner.target as 'console')?.name;
    if (name !== expected)
      throw new IdpError('IDP_CONFLICT', 'This group was renamed in Polaris ID.');
    return {
      body: res.body as Record<string, unknown>,
      put: r.groupClaims(id),
      read: r.group(id),
    };
  }

  /** Subject owners must be known to the binding; the listed keys need an account it created or linked. */
  async function classFor(owner: Resolved): Promise<'created' | 'linked' | 'external' | null> {
    return owner.kind === 'subject' ? subjectClass(db, owner.subject) : null;
  }

  return {
    async claims(owner) {
      const o = await call.guard(meta('claims'), () => assertOwner(owner));
      const { registry, settings } = await gate.readable();
      const m = meta('claims', {
        target: o.kind === 'subject' ? o.subject : o.target,
      });
      return call.ledgered('claims_read', m, async (req): Promise<ClaimView> => {
        if (o.kind === 'subject' && !(await classFor(o)))
          refuse('The binding does not know this account.');
        const { body } = await load(req, o, registry);
        if (o.kind === 'subject') assertClaimable(body, o.subject, registry, null);
        const claims: ClaimView['claims'] = {};
        let other = 0;
        for (const c of parseClaims(body)) {
          if (keyKind(c.key, settings.claimKeys)) claims[c.key] = decode(c.value);
          else other += 1;
        }
        return { claims, otherKeys: other };
      });
    },

    async setClaims(owner, changes, ctx) {
      const c = await call.guard(meta('setClaims'), () => assertCtx(ctx));
      const m0 = ctxMeta('setClaims', c);
      const o = await call.guard(m0, () => assertOwner(owner));
      const target = o.kind === 'subject' ? o.subject : o.target;
      const { registry, settings, keySubject } = await gate.requireWrite({ ...m0, target });
      const ch = await call.guard({ ...m0, target }, () =>
        assertChanges(changes, settings.claimKeys, true),
      );
      // Key names and value lengths only: never a value.
      const label = Object.entries(ch).map(([k, v]) =>
        v === null ? `-${k}` : `+${k}(${JSON.stringify(v.value ?? '').length})`,
      );
      const m = { ...m0, target, role: Object.keys(ch).join(','), delta: label.join(',') };
      const klass = await classFor(o);
      if (o.kind === 'subject') {
        if (!klass) await call.guard(m, () => refuse('The binding does not know this account.'));
        if (
          klass === 'external' &&
          Object.keys(ch).some((k) => keyKind(k, settings.claimKeys) === 'listed')
        )
          await call.guard(m, () => refuse('Claim key not allowed for this account.'));
      }
      const bucket: Bucket = c.dryRun ? 'preview' : 'claims_write';
      return call.ledgered(bucket, m, (req) =>
        withLock(
          db,
          o.kind === 'subject' ? o.subject : `g:claims:${o.target}`,
          deps.now,
          async () => {
            const { body, put, read } = await load(req, o, registry);
            if (o.kind === 'subject') assertClaimable(body, o.subject, registry, keySubject);
            const current = parseClaims(body);
            const { next, set, removed } = merge(current, ch, settings.claimKeys);
            if (sameClaims(current, next)) return { set, removed, dryRun: false };
            if (s.dry(c.dryRun)) {
              await noteCall(db, 'dry_run', m, deps.now(), 'dry_run');
              return { set, removed, dryRun: true };
            }
            const res = await req('PUT', put, next);
            if (!ok(res)) throw failure(res);
            const back = await req('GET', read);
            if (!ok(back)) throw failure(back);
            if (!sameClaims(parseClaims(back.body), next)) {
              alert('error', 'binding.drift', { target: m.target });
              throw new IdpError('IDP_DRIFT', 'The claims changed while they were being written.');
            }
            return { set, removed, dryRun: false };
          },
        ),
      );
    },
  };
}
