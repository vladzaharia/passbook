import type { Mode } from '../../../shared/contracts/common.ts';
import type { TagProgramState } from '../../../shared/contracts/nfc-tag-programs.ts';
import { type Grant, type GrantedStatement, grant } from '../../platform/authority.ts';
import type { Check } from '../../platform/authority-checks.ts';
import { inList, lt } from '../../platform/authority-expr.ts';
import type { Principal } from '../../platform/authority-principal.ts';
import type { Envelope } from '../../platform/crypto.ts';
import { all, first } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { type EnvelopeRaw, envelopeOf } from './keyset-seal.ts';

/** Who programs: a scanner (with the staff member signed in) or an API key's own reader. */
export interface ProgramActor {
  type: 'scanner' | 'api_key';
  /** The scanner id or the API key id. */
  id: string;
  staffId: string | null;
}

/**
 * What a caller proves: the tenant, the principal of its grant and the checks that keep it live (scanner and
 * staff epochs, the capability). The device routes build it from the scan actor; the service never reads a
 * request.
 */
export interface ProgramAuthority {
  orgId: string;
  mode: Mode;
  principal: Principal;
  checks: Check[];
  actor: ProgramActor;
}

export interface ProgramRow {
  id: string;
  orgId: string;
  mode: Mode;
  keysetId: string;
  keyVersion: number;
  tagRef: string;
  hint: string;
  actorKey: string;
  purpose: 'blank' | 'rekey' | 'reset';
  state: TagProgramState;
  step: 'auth' | 'reauth' | 'probe' | 'result' | 'done';
  attempts: number;
  errorCode: string | null;
  intended: Envelope | null;
  session: Envelope | null;
  tagId: string | null;
  bindingId: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

interface Raw {
  id: string;
  org_id: string;
  mode: Mode;
  keyset_id: string;
  key_version: number;
  tag_ref: string;
  hint: string;
  actor_key: string;
  purpose: ProgramRow['purpose'];
  state: TagProgramState;
  step: ProgramRow['step'];
  attempts: number;
  error_code: string | null;
  kek_version: number | null;
  iv: EnvelopeRaw['iv'] | null;
  wrapped_dek: EnvelopeRaw['wrapped_dek'] | null;
  ciphertext: EnvelopeRaw['ciphertext'] | null;
  sess_kek_version: number | null;
  sess_iv: EnvelopeRaw['iv'] | null;
  sess_wrapped_dek: EnvelopeRaw['wrapped_dek'] | null;
  sess_ciphertext: EnvelopeRaw['ciphertext'] | null;
  tag_id: string | null;
  binding_id: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

const COLUMNS = `id, org_id, mode, keyset_id, key_version, tag_ref, hint, actor_key, purpose, state, step, attempts,
  error_code, kek_version, iv, wrapped_dek, ciphertext, sess_kek_version, sess_iv, sess_wrapped_dek, sess_ciphertext,
  tag_id, binding_id, created_at, updated_at, expires_at`;

const rowOf = (r: Raw): ProgramRow => ({
  id: r.id,
  orgId: r.org_id,
  mode: r.mode,
  keysetId: r.keyset_id,
  keyVersion: r.key_version,
  tagRef: r.tag_ref,
  hint: r.hint,
  actorKey: r.actor_key,
  purpose: r.purpose,
  state: r.state,
  step: r.step,
  attempts: r.attempts,
  errorCode: r.error_code,
  intended:
    r.kek_version === null
      ? null
      : envelopeOf({
          kek_version: r.kek_version,
          iv: r.iv as EnvelopeRaw['iv'],
          wrapped_dek: r.wrapped_dek as EnvelopeRaw['wrapped_dek'],
          ciphertext: r.ciphertext as EnvelopeRaw['ciphertext'],
        }),
  session:
    r.sess_kek_version === null
      ? null
      : envelopeOf({
          kek_version: r.sess_kek_version,
          iv: r.sess_iv as EnvelopeRaw['iv'],
          wrapped_dek: r.sess_wrapped_dek as EnvelopeRaw['wrapped_dek'],
          ciphertext: r.sess_ciphertext as EnvelopeRaw['ciphertext'],
        }),
  tagId: r.tag_id,
  bindingId: r.binding_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  expiresAt: r.expires_at,
});

/** A program of this tenant. Another tenant's id reads as no row. */
export async function programById(
  db: D1Database,
  orgId: string,
  mode: Mode,
  id: string,
): Promise<ProgramRow | null> {
  const r = await first<Raw>(
    db,
    `SELECT ${COLUMNS} FROM nfc_tag_programs WHERE id = ? AND org_id = ? AND mode = ?`,
    [id, orgId, mode],
  );
  return r && rowOf(r);
}

/** The tag's one unresolved row: open, abandoned, or failed with keys. A failed row that never held keys is not one. */
export async function unresolvedByRef(
  db: D1Database,
  orgId: string,
  mode: Mode,
  ref: string,
): Promise<ProgramRow | null> {
  const r = await first<Raw>(
    db,
    `SELECT ${COLUMNS} FROM nfc_tag_programs WHERE org_id = ? AND mode = ? AND tag_ref = ?
       AND (state IN ('started', 'scripted', 'interrupted', 'abandoned') OR (state = 'failed' AND kek_version IS NOT NULL))`,
    [orgId, mode, ref],
  );
  return r && rowOf(r);
}

/** A start this actor already made with this key. */
export async function programByIdem(
  db: D1Database,
  orgId: string,
  mode: Mode,
  actorKey: string,
  idem: string,
): Promise<ProgramRow | null> {
  const r = await first<Raw>(
    db,
    `SELECT ${COLUMNS} FROM nfc_tag_programs WHERE org_id = ? AND mode = ? AND actor_key = ? AND idem_key = ?`,
    [orgId, mode, actorKey, idem],
  );
  return r && rowOf(r);
}

export interface ProgramKeyset {
  id: string;
  slug: string;
  typeId: string | null;
  perTag: boolean;
  programmable: boolean;
  disabled: boolean;
}

export async function programKeyset(
  db: D1Database,
  orgId: string,
  mode: Mode,
  id: string,
): Promise<ProgramKeyset | null> {
  const r = await first<{
    id: string;
    slug: string;
    type_id: string | null;
    per_tag: number;
    programmable: number;
    disabled_at: number | null;
  }>(
    db,
    `SELECT id, slug, type_id, per_tag, programmable, disabled_at FROM nfc_tag_keysets
      WHERE id = ? AND org_id = ? AND mode = ?`,
    [id, orgId, mode],
  );
  return (
    r && {
      id: r.id,
      slug: r.slug,
      typeId: r.type_id,
      perTag: r.per_tag === 1,
      programmable: r.programmable === 1,
      disabled: r.disabled_at !== null,
    }
  );
}

/** The org's only live programmable keyset in this mode, when the request names none. Null if there is not exactly one. */
export async function onlyProgrammableKeyset(
  db: D1Database,
  orgId: string,
  mode: Mode,
): Promise<string | null> {
  const rows = await all<{ id: string }>(
    db,
    `SELECT id FROM nfc_tag_keysets WHERE org_id = ? AND mode = ? AND programmable = 1 AND per_tag = 1
       AND disabled_at IS NULL LIMIT 2`,
    [orgId, mode],
  );
  return rows.length === 1 ? (rows[0]?.id ?? null) : null;
}

export type ProgramPurpose = 'org_mode.nfc.tag.program';

/** The grant of every program write: the caller's own checks first, then this call's. */
export function programGrant(
  ctx: ServiceContext,
  a: ProgramAuthority,
  checks: Check[] = [],
  tables: readonly string[] = ['nfc_tag_programs'],
  codes: Record<string, string> = {},
): Grant {
  return grant(ctx, {
    purpose: 'org_mode.nfc.tag.program',
    principal: a.principal,
    checks: [...a.checks, ...checks],
    codes: { lineage: 'TAG_PROGRAM_FAILED', stale: 'TAG_PROGRAM_FAILED', ...codes },
    tables: [...tables],
  });
}

export interface NewProgram {
  id: string;
  keysetId: string;
  keyVersion: number;
  tagRef: string;
  hint: string;
  actor: ProgramActor;
  idem: string;
  session: Envelope;
  now: number;
  expiresAt: number;
}

const sessionColumns = (e: Envelope | null) => ({
  sess_kek_version: e?.kekVersion ?? null,
  sess_iv: e?.iv ?? null,
  sess_wrapped_dek: e?.wrappedDek ?? null,
  sess_ciphertext: e?.ciphertext ?? null,
});

/** A fresh started row at attempt one, holding its session and no keys. A second row for the tag is a unique violation. */
export function insertProgram(g: Grant, p: NewProgram): GrantedStatement {
  const actor = {
    actor_type: p.actor.type,
    actor_key: `${p.actor.type}:${p.actor.id}`,
    scanner_id: p.actor.type === 'scanner' ? p.actor.id : null,
    staff_id: p.actor.staffId,
    api_key_id: p.actor.type === 'api_key' ? p.actor.id : null,
  };
  const row = {
    id: p.id,
    keyset_id: p.keysetId,
    key_version: p.keyVersion,
    tag_ref: p.tagRef,
    hint: p.hint,
    ...actor,
    purpose: 'blank',
    state: 'started',
    step: 'auth',
    attempts: 1,
    ...sessionColumns(p.session),
    idem_key: p.idem,
    created_at: p.now,
    updated_at: p.now,
    expires_at: p.expiresAt,
  };
  return g.insertSelect('nfc_tag_programs', Object.keys(row), Object.values(row), {
    returning: ['id'],
  });
}

export interface Move {
  /** The states the row must be in (compare and set), and the step when it matters. */
  from: TagProgramState[];
  step?: ProgramRow['step'];
  to: TagProgramState;
  toStep: ProgramRow['step'];
  now: number;
  session?: Envelope | null;
  intended?: Envelope;
  expiresAt?: number;
  errorCode?: string | null;
  /** One more auth part 2 released; refused at the cap. */
  attempt?: { cap: number };
  /** The tag the row became. */
  tagId?: string;
  /** Keys are cleared with the row's end. */
  clearKeys?: boolean;
}

/** One compare-and-set of a row. `changed` is false when another call moved it first or the cap held. */
export function moveProgram(g: Grant, id: string, m: Move): GrantedStatement {
  const set: Record<string, string | number | Uint8Array | null> = {
    state: m.to,
    step: m.toStep,
    updated_at: m.now,
    ...sessionColumns(m.session ?? null),
  };
  if (m.errorCode !== undefined) set.error_code = m.errorCode;
  if (m.expiresAt !== undefined) set.expires_at = m.expiresAt;
  if (m.tagId !== undefined) set.tag_id = m.tagId;
  if (m.intended) {
    set.kek_version = m.intended.kekVersion;
    set.iv = m.intended.iv;
    set.wrapped_dek = m.intended.wrappedDek;
    set.ciphertext = m.intended.ciphertext;
  }
  if (m.clearKeys) {
    set.kek_version = null;
    set.iv = null;
    set.wrapped_dek = null;
    set.ciphertext = null;
  }
  return g.update('nfc_tag_programs', {
    set,
    ...(m.attempt ? { inc: ['attempts'] } : {}),
    where: {
      id,
      state: m.from.length === 1 ? (m.from[0] as string) : inList(m.from),
      ...(m.step ? { step: m.step } : {}),
      ...(m.attempt ? { attempts: lt(m.attempt.cap) } : {}),
    },
    returning: ['id'],
  });
}

/** Whether the statement changed a row: `returning` makes the count exact. */
export const changed = (results: D1Result[], g: Grant, s: GrantedStatement): boolean =>
  (results[g.indexOf(s)]?.results?.length ?? 0) === 1;
