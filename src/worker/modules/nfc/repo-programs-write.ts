import type { TagProgramState } from '../../../shared/contracts/nfc-tag-programs.ts';
import type { Grant, GrantedStatement } from '../../platform/authority.ts';
import { inList, lt } from '../../platform/authority-expr.ts';
import type { Envelope } from '../../platform/crypto.ts';
import type { ProgramActor, ProgramRow } from './repo-programs.ts';

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
