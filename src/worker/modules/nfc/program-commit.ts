import type { z } from 'zod';
import type {
  TagProgramDoneSchema,
  TagProgramResultSchema,
} from '../../../shared/contracts/nfc-tag-programs.ts';
import { exactlyOne } from '../../platform/authority-checks.ts';
import { exists } from '../../platform/authority-cond.ts';
import { ne } from '../../platform/authority-expr.ts';
import { loadKekRing } from '../../platform/crypto.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { AppError, ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import { sealTagKey } from './keyset-seal.ts';
import { type BindOutcome, planBind } from './program-bind.ts';
import { endHold, loadHold, nfcChecks, notFound, programAudit, scopeOf } from './program-hold.ts';
import { programError } from './program-recover.ts';
import { checkBatch, sessionOf } from './program-script.ts';
import { openIntended, sealAdmin } from './program-seal.ts';
import { insertAdminKeys } from './repo-admin-keys.ts';
import {
  type ProgramAuthority,
  type ProgramRow,
  programById,
  programGrant,
  programKeyset,
} from './repo-programs.ts';
import { moveProgram } from './repo-programs-write.ts';
import { orgTagCount, tagView } from './repo-tags.ts';
import { addBind } from './repo-tags-write.ts';
import { verifySun } from './sun.ts';
import { parseSunUrl } from './sun-url.ts';
import { tagRef } from './tag-ref.ts';
import { TAGS_PER_ORG_MODE } from './tags.ts';

type Done = z.infer<typeof TagProgramDoneSchema>;
type Result = z.infer<typeof TagProgramResultSchema>;

const TABLES = [
  'nfc_tag_programs',
  'nfc_tags',
  'nfc_tag_sun',
  'nfc_tag_admin_keys',
  'tag_bindings',
];

async function doneOf(ctx: ServiceContext, row: ProgramRow, refusal: string | null): Promise<Done> {
  const tag = row.tagId ? await tagView(ctx.env.DB, row.orgId, row.mode, row.tagId) : null;
  return {
    state: row.state,
    tag: tag ? { id: tag.id, hint: row.hint } : null,
    binding: tag?.binding ?? null,
    refusal: refusal as Done['refusal'],
  };
}

/**
 * The end of a hold: every response checked in order, then the read-back (the tag's own URL, read free after
 * the script) verified against the keys we meant to write. Only then is the tag made: its row, its side row, its
 * admin keys, the program's end and (when asked) the binding, in one batch. A tag that tore anywhere before this
 * keeps its sealed keys and is resumed by the next hold; none of this runs on a response that failed.
 */
export async function resultProgram(
  ctx: ServiceContext,
  a: ProgramAuthority,
  id: string,
  req: Result,
): Promise<Done> {
  const done = await programById(ctx.env.DB, a.orgId, a.mode, id);
  if (!done) throw notFound();
  if (done.state === 'programmed') return doneOf(ctx, done, null);
  const { row, session } = await loadHold(ctx, a, id);
  if (row.state !== 'scripted' || row.step !== 'result' || !session.expect || !row.intended)
    throw programError('TAG_PROGRAM_FAILED');
  const checked = await checkBatch(
    sessionOf(session),
    session.expect,
    req.responses.map((r) => r.toLowerCase()),
  );
  if (!checked.ok)
    return endHold(ctx, a, row, checked.why === 'short' ? 'TAG_MOVED' : 'TAG_PROGRAM_FAILED');
  const ring = await loadKekRing(ctx.env);
  const keys = await openIntended(ring, scopeOf(row), row.id, row.intended);
  const keyset = await programKeyset(ctx.env.DB, row.orgId, row.mode, row.keysetId);
  if (!keyset) return endHold(ctx, a, row, 'TAG_PROGRAM_FAILED');
  // The Plain write has no MAC, so the read-back is the only proof of what the tag holds.
  const url = req.readback.ndef?.type === 'U' ? parseSunUrl(req.readback.ndef.value) : null;
  if (!url || url.host !== new URL(ctx.env.PUBLIC_BASE_URL).host || url.slug !== keyset.slug)
    return endHold(ctx, a, row, 'TAG_PROGRAM_FAILED');
  const read = await verifySun(
    { metaKey: keys[1] as Uint8Array, fileKey: keys[2] as Uint8Array, diversified: false },
    url.p,
    url.m,
  );
  if (!read.ok) return endHold(ctx, a, row, 'TAG_PROGRAM_FAILED');
  // The read names the tag the keys were released for, not another one the device holds.
  if ((await tagRef(ctx.env, row.orgId, row.mode, read.read.uid)).ref !== row.tagRef)
    return endHold(ctx, a, row, 'TAG_PROGRAM_FAILED');
  if ((await orgTagCount(ctx.env.DB, row.orgId, row.mode)) >= TAGS_PER_ORG_MODE)
    throw new ConflictError('This organization has the most tags allowed.', 'TAG_LIMIT');

  const tagId = ctx.ids.id();
  const bound = req.bind ? await planBind(ctx, a, tagId, req.bind) : null;
  const refusal = bound && 'refusal' in bound ? bound.refusal : null;
  try {
    await commit(
      ctx,
      a,
      ring,
      { row, keys, slug: keyset.slug, typeId: keyset.typeId, ctr: read.read.counter, tagId },
      bound,
    );
    return doneOf(ctx, { ...row, state: 'programmed', tagId }, refusal);
  } catch (error) {
    const bind = bound && 'plan' in bound;
    // A bind that went stale in the meantime is not a reason to lose the tag: set it up as a spare.
    if (bind && error instanceof AppError && error.code === 'TAG_HOLDER_CHANGED') {
      await commit(
        ctx,
        a,
        ring,
        { row, keys, slug: keyset.slug, typeId: keyset.typeId, ctr: read.read.counter, tagId },
        { refusal: 'TAG_HOLDER_CHANGED' },
      );
      return doneOf(ctx, { ...row, state: 'programmed', tagId }, 'TAG_HOLDER_CHANGED');
    }
    if (classifyD1Error(error)?.kind === 'unique') throw programError('TAG_KNOWN');
    throw error;
  }
}

interface Made {
  row: ProgramRow;
  keys: Uint8Array[];
  slug: string;
  typeId: string | null;
  ctr: number;
  tagId: string;
}

async function commit(
  ctx: ServiceContext,
  a: ProgramAuthority,
  ring: Awaited<ReturnType<typeof loadKekRing>>,
  m: Made,
  bound: BindOutcome | null,
): Promise<void> {
  const { row, tagId } = m;
  const scope = scopeOf(row);
  const now = ctx.clock.now();
  const sun = await sealTagKey(ring, scope, tagId, m.keys[2] as Uint8Array);
  const admin = await sealAdmin(ring, scope, tagId, m.keys);
  const bind = bound && 'plan' in bound ? bound : null;
  const g = programGrant(
    ctx,
    a,
    [
      ...nfcChecks(),
      exactlyOne(
        'nfc_tag_programs',
        { id: row.id, state: 'scripted', step: 'result' },
        undefined,
        'stale',
      ),
      exactlyOne(
        'nfc_tag_keysets',
        { id: row.keysetId, slug: m.slug, disabled_at: null },
        undefined,
        'stale',
      ),
      exactlyOne(
        'nfc_tag_keys',
        { keyset_id: row.keysetId, version: row.keyVersion, state: ne('retired') },
        'keyset_id',
        'stale',
      ),
      ...(bind?.checks ?? []),
    ],
    TABLES,
    { lineage: 'TAG_HOLDER_CHANGED' },
  );
  g.insertSelect(
    'nfc_tags',
    ['id', 'tag_ref', 'system', 'type_id', 'hint', 'label', 'created_at'],
    [tagId, row.tagRef, 'sun', m.typeId, row.hint, null, now],
    { returning: ['id'] },
  );
  g.insertJoined('nfc_tag_sun', {
    parents: { tag_id: tagId },
    columns: [
      'keyset_id',
      'key_version',
      'kek_version',
      'iv',
      'wrapped_dek',
      'ciphertext',
      'ctr',
      'ctr_at',
    ],
    values: [
      row.keysetId,
      row.keyVersion,
      sun.kekVersion,
      sun.iv,
      sun.wrappedDek,
      sun.ciphertext,
      m.ctr,
      now,
    ],
    returning: ['tag_id'],
  });
  insertAdminKeys(g, tagId, { id: row.keysetId, version: row.keyVersion }, admin, now);
  moveProgram(g, row.id, {
    from: ['scripted'],
    step: 'result',
    to: 'programmed',
    toStep: 'done',
    now,
    session: null,
    tagId,
    clearKeys: true,
    errorCode: null,
  });
  if (bind) addBind(g, ctx, bind.plan);
  grantedAudit(
    g,
    ctx,
    programAudit(a, row, 'nfc_tag.programmed', {
      tagId,
      ...(bind ? { bindingId: bind.plan.bindingId } : {}),
    }),
    [exists('nfc_tag_programs', { id: row.id, state: 'programmed' })],
  );
  await g.commit();
  ctx.log.info('nfc.program.done', { orgId: row.orgId, programId: row.id, hint: row.hint });
}
