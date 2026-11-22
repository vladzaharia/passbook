import type { z } from 'zod';
import type {
  ImportTagsSchema,
  TagImportResultSchema,
} from '../../../shared/contracts/nfc-tag-keysets.ts';
import { loadKekRing } from '../../platform/crypto.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { type ImportProblem, parseImportCsv } from './import-csv.ts';
import { openVersion, sealTagKey } from './keyset-seal.ts';
import { commitKeyset, conflict, keysetIn, scopeOf } from './keysets.ts';
import {
  existingRefs,
  type ImportedTag,
  importGrant,
  ownKeyTags,
  rekeyGrant,
} from './repo-import.ts';
import { keyVersionsOf, versionEnvelopes } from './repo-keysets.ts';
import { type KeysetAuthority, keysetActorId } from './repo-keysets-write.ts';
import { bytesToHex, hexToBytes } from './sun.ts';
import { tagRef } from './tag-ref.ts';

export type ImportResult = z.infer<typeof TagImportResultSchema>;
const SHOWN = 50;
/** Tags per batch: each is three statements, and the keys are sealed one by one. */
const CHUNK = 40;

/**
 * Registers a supplier's tags on a per-tag keyset: each as a spare Secure tag whose own file key is sealed
 * (AES-GCM envelope, bound to its tag, keyset, mode and org) and never returned or logged. A dry run reads the
 * file and the org's tags and reports what would be added; nothing is written. Duplicates (in the file, or
 * a tag the org already has, Basic ones included) and bad rows are listed, never added. The rest go in.
 * With `replace`, rows name tags already on this keyset with keys of their own and swap their sealed key
 * (counters and bindings stay; the tag must be rewritten); anything else is listed as `not_on_keyset`.
 */
export async function importTags(
  ctx: ServiceContext,
  a: KeysetAuthority,
  keysetId: string,
  input: z.infer<typeof ImportTagsSchema>,
): Promise<ImportResult> {
  const keyset = await keysetIn(ctx, a, keysetId);
  if (!keyset.perTag) throw conflict('This keyset takes no imported tags.', 'KEYSET_NOT_PER_TAG');
  if (keyset.disabledAt !== null) throw conflict('This keyset is disabled.', 'KEYSET_DISABLED');
  const active = ((await keyVersionsOf(ctx.env.DB, [keyset.id])).get(keyset.id) ?? []).find(
    (v) => v.state === 'active',
  );
  if (!active) throw conflict('Rotate the keyset first.', 'KEYSET_NO_ACTIVE_KEY');
  const parsed = parseImportCsv(input.csv);
  const problems: ImportProblem[] = [...parsed.problems];
  // A tag key equal to the shared meta key would let any reader of a tap's PICC data forge its MAC. Only the
  // add checks it: a dry run that did would tell a caller which guessed key is the meta key, for free.
  if (!input.dryRun) {
    const [current] = await versionEnvelopes(ctx.env.DB, keyset.id, ['active']);
    const meta = current
      ? bytesToHex(
          (
            await openVersion(
              await loadKekRing(ctx.env),
              { ...scopeOf(keyset), keyId: current.id, version: current.version },
              current.envelope,
            )
          ).meta,
        )
      : '';
    parsed.rows = parsed.rows.filter((r) => {
      if (r.key !== meta) return true;
      problems.push({ line: r.line, uid: r.uid, reason: 'meta_key' });
      return false;
    });
  }
  const refs = await Promise.all(
    parsed.rows.map(async (r) => ({ row: r, ...(await tagRef(ctx.env, a.orgId, a.mode, r.uid)) })),
  );
  const refList = refs.map((r) => r.ref);
  const replace = input.replace === true;
  const own = replace ? await ownKeyTags(ctx.env.DB, a.orgId, a.mode, keyset.id, refList) : null;
  const taken = replace ? null : await existingRefs(ctx.env.DB, a.orgId, a.mode, refList);
  const fresh = refs.filter((r) => {
    if (own ? own.has(r.ref) : !taken?.has(r.ref)) return true;
    problems.push({ line: r.row.line, uid: r.row.uid, reason: own ? 'not_on_keyset' : 'exists' });
    return false;
  });
  let added = 0;
  if (!input.dryRun && fresh.length > 0) {
    const ring = await loadKekRing(ctx.env);
    const scope = scopeOf(keyset);
    for (let i = 0; i < fresh.length; i += CHUNK) {
      const tags: ImportedTag[] = [];
      for (const r of fresh.slice(i, i + CHUNK)) {
        const tagId = own?.get(r.ref) ?? ctx.ids.id();
        tags.push({
          tagId,
          ref: r.ref,
          hint: r.hint,
          envelope: await sealTagKey(ring, scope, tagId, hexToBytes(r.row.key) as Uint8Array),
        });
      }
      const target = { id: keyset.id, version: active.version };
      const { grant, writes } = replace
        ? (({ grant, updates }) => ({ grant, writes: updates }))(rekeyGrant(ctx, a, target, tags))
        : (({ grant, inserts }) => ({ grant, writes: inserts }))(importGrant(ctx, a, target, tags));
      const before = added;
      const results = await commitKeyset(grant, a).catch((error: unknown) => {
        if (added > 0 && error instanceof AppError)
          throw conflict(
            `${added} tags were imported before the keyset changed. Check the file again for the rest.`,
            'IMPORT_PARTIAL',
          );
        throw error;
      });
      const done = writes.map((s) => (results[grant.indexOf(s)]?.results?.length ?? 0) === 1);
      added += done.filter(Boolean).length;
      if (replace)
        await recordAudit(ctx, {
          orgId: a.orgId,
          actorType: a.kind === 'api_key' ? 'api_key' : 'user',
          actorId: keysetActorId(a),
          ...(a.ip ? { ipPrefix: a.ip } : {}),
          action: 'tag_keyset.rekeyed',
          targetType: 'tag_keyset',
          targetId: keyset.id,
          detail: {
            count: added - before,
            tagIds: tags.filter((_, n) => done[n]).map((t) => t.tagId),
          },
        });
    }
  }
  problems.sort((x, y) => x.line - y.line);
  return {
    dryRun: input.dryRun,
    rows: parsed.count,
    ok: input.dryRun ? fresh.length : added,
    added,
    problems: problems.slice(0, SHOWN),
    moreProblems: Math.max(0, problems.length - SHOWN),
  };
}
