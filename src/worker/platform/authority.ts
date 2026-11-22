// The only module that builds guarded writes. Contract: docs/design/authority-epochs.md section 1.2.
import type { AfterRead } from './authority-after.ts';
import { type AuditRow, type AuditWhen, buildAudit, withVia } from './authority-audit.ts';
import { grantedBatch, grantedBatchWith, registerPrepare } from './authority-batch.ts';
import type { Check } from './authority-checks.ts';
import { buildAssert, type GrantCond } from './authority-cond.ts';
import { assertOwnStatement, assertTableAllowed, translateDenial } from './authority-denial.ts';
import { limitHitOf } from './authority-entitled.ts';
import { AuthorityError } from './authority-error.ts';
import { identifier } from './authority-expr.ts';
import {
  assertDeferredContext,
  builtOf,
  type GrantedStatement,
  type GrantInput,
  grantInsert,
  newGrantedStatement,
  scopeOf,
} from './authority-granted.ts';
import { buildPart, type GrantPart } from './authority-include.ts';
import { type JobGrantInput, jobGrantInputOf } from './authority-job-grant.ts';
import {
  buildInsertJoined,
  buildJoined,
  type InsertJoinedOptions,
  type JoinedOptions,
} from './authority-joined.ts';
import { personalOrgInsert, personalOrgOnlyInserts } from './authority-personal.ts';
import { joinLedgerRow, joinOnlyInserts, pinOf } from './authority-pin.ts';
import type { GrantScope, Principal } from './authority-principal.ts';
import { assertReceipt, type ReceiptStatement } from './authority-receipt.ts';
import { keyMayJoin, keyMayRow, keyMayWrite } from './authority-restrict.ts';
import {
  assertBudget,
  type BuiltStatement,
  buildDelete,
  buildInsertSelect,
  buildUpdate,
  type InsertOptions,
  PARAM_BUDGET,
  WRITE_PARAM_BUDGET,
  type WriteOptions,
} from './authority-statements.ts';
import { buildUpsert, type UpsertOptions } from './authority-upsert.ts';
import { exactStmt, type SqlValue } from './db.ts';
import type { DenyReason, LimitHit } from './errors.ts';
import { assertJobGrantAllowed, hasFullJobAuthority } from './job-authority.ts';
import type { ServiceContext } from './service-context.ts';

export type { AuditRow } from './authority-audit.ts';
export { grantedBatch } from './authority-batch.ts';
export type { GrantedStatement, GrantInput } from './authority-granted.ts';
export { authorityDenial, sweepLeakedGrants } from './authority-granted.ts';
export type { JobGrantInput } from './authority-job-grant.ts';

type Size = { params: number; bytes: number };
export class Grant {
  readonly id: string;
  readonly scope: GrantScope;
  readonly purpose: string;
  readonly principal: Principal;
  /** Grants share a batch only when their refusal codes are identical (see `grantedBatch`). */
  readonly codesKey: string;
  readonly #db: D1Database;
  readonly #input: GrantInput;
  readonly #now: number;
  /** The pass a holder grant is pinned to (its `target`); undefined for every other principal. */
  readonly #pin: string | undefined;
  readonly #tables: ReadonlySet<string> | undefined;
  readonly #lineage: Check[] = [];
  /** An API key principal: its statements carry the key's template limits. */
  readonly #keyed: boolean;
  /** A statement writes what a key limited to templates may not (no template dimension, or a part); that key is denied. */
  #limitedRefused = false;
  #statements: GrantedStatement[] = [];
  #committed = false;

  static {
    registerPrepare((g) => (g as Grant).#prepare());
  }

  constructor(db: D1Database, id: string, scope: GrantScope, input: GrantInput, now: number) {
    this.id = id;
    this.scope = scope;
    this.purpose = input.purpose;
    this.principal = input.principal;
    this.codesKey = JSON.stringify(Object.entries(input.codes ?? {}).sort());
    this.#db = db;
    this.#input = input;
    this.#now = now;
    this.#pin = pinOf(input.principal, input.target);
    this.#keyed = input.principal.kind === 'api_key';
    this.#tables = input.tables ? new Set(input.tables.map(identifier)) : undefined;
    this.#insert();
  }

  /** Whether writes are pinned to the grant's one pass (holder and join grants): pass `{ holder: g.pinned }` to `sealPart`. */
  get pinned(): boolean {
    return this.#pin !== undefined;
  }

  /** Built at prepare time: `require: 'one'` writes add their lineage checks to it. */
  #insert(): BuiltStatement {
    return grantInsert(
      this.id,
      this.scope,
      this.#input,
      this.#lineage,
      this.#now,
      this.#limitedRefused,
    );
  }

  #push(built: BuiltStatement): GrantedStatement {
    if (this.#committed)
      throw new AuthorityError('GRANT_ALREADY_COMMITTED', 'This grant was committed.');
    assertBudget(built.sql, built.params, built.read ? PARAM_BUDGET : WRITE_PARAM_BUDGET);
    if (built.lineage) this.#lineage.push(built.lineage);
    if (built.limitRefused && this.#keyed) this.#limitedRefused = true;
    const statement = newGrantedStatement(this.id, built);
    this.#statements.push(statement);
    return statement;
  }

  /** A typed write: the join-link rule, the key's template limit, then the statement from `build`. */
  #write(
    verb: string | null,
    may: boolean,
    table: string,
    build: (table: string, pin: string | undefined, keyed: boolean) => BuiltStatement,
    op: 'insert' | 'change' = 'change',
  ): GrantedStatement {
    if (verb) joinOnlyInserts(this.principal, verb);
    if (verb) personalOrgOnlyInserts(this.purpose, verb);
    if (this.#keyed && !may) this.#limitedRefused = true;
    // A write outside the grant's `tables` is a programming error.
    const allowed = assertTableAllowed(this.purpose, this.#tables, table, op);
    return this.#push(build(allowed, this.#pin, this.#keyed));
  }

  update(table: string, options: WriteOptions): GrantedStatement {
    return this.#write('updating', keyMayRow(table), table, (t, pin, keyed) =>
      buildUpdate(this.id, this.scope, t, options, pin, keyed),
    );
  }

  delete(table: string, options: Omit<WriteOptions, 'set' | 'inc'>): GrantedStatement {
    return this.#write('deleting', keyMayRow(table), table, (t, pin, keyed) =>
      buildDelete(this.id, this.scope, t, options, pin, keyed),
    );
  }

  insertSelect(
    table: string,
    columns: string[],
    values: SqlValue[],
    options?: InsertOptions,
  ): GrantedStatement {
    joinLedgerRow(this.principal, table, columns, values);
    personalOrgInsert(this.#input, table, columns, values, options?.from !== undefined);
    return this.#write(
      null,
      keyMayRow(table, options?.from),
      table,
      (t, pin, keyed) =>
        buildInsertSelect(this.id, this.scope, t, columns, values, options, pin, keyed),
      'insert',
    );
  }

  /** Insert, or change the existing row at the table's fixed conflict target (see `UpsertOptions`). */
  upsert(
    table: string,
    columns: string[],
    values: SqlValue[],
    options: UpsertOptions,
  ): GrantedStatement {
    return this.#write('upserting', keyMayRow(table, options.from), table, (t, pin, keyed) =>
      buildUpsert(this.id, this.scope, t, columns, values, options, pin, keyed),
    );
  }

  /** Update or delete an org-less child through a declared foreign key to a parent in the tenant. */
  joined(table: string, options: JoinedOptions): GrantedStatement {
    return this.#write('updating', keyMayJoin(table, options.via), table, (t, pin, keyed) =>
      buildJoined(this.id, this.scope, t, options, pin, keyed),
    );
  }

  /** Insert an org-less child under parents in the tenant; the parent rows supply its foreign keys. */
  insertJoined(table: string, options: InsertJoinedOptions): GrantedStatement {
    return this.#write(
      'inserting children',
      keyMayWrite(table.toLowerCase()),
      table,
      (t, pin, keyed) => buildInsertJoined(this.id, this.scope, t, options, pin, keyed),
      'insert',
    );
  }

  /** Adds statements built elsewhere for this grant (hooks must return these, never run after commit). */
  add(...statements: GrantedStatement[]): void {
    for (const s of statements) {
      assertOwnStatement(s, this.id);
      if (!this.#statements.includes(s)) this.#statements.push(s);
    }
  }

  /**
   * Appends one audit row that commits in this grant's batch and only while the grant row exists.
   * `detail` must already be redacted JSON. A tenant grant writes its own org; a named `entry.orgId`
   * must equal it or the batch is refused. `when` is read-only SQL (or `GrantCond`s), evaluated at the
   * statement's position in the batch: add the audit before a write to ask "was it still unrevoked?",
   * after an insert to ask "does the new row exist?".
   */
  audit(entry: AuditRow, when?: AuditWhen): GrantedStatement {
    return this.#push(buildAudit(this.id, this.scope, withVia(entry, this.#input.via), when));
  }

  /**
   * A mid-batch abort: the batch is refused with `authority_denied:<reason>` unless every condition holds
   * at this point (`when` false skips it). Count rows with `returning` or asserts, never `meta.changes`.
   */
  assert(
    reason: DenyReason,
    conds: GrantCond[],
    options: { when?: GrantCond[] } = {},
  ): GrantedStatement {
    return this.#push(buildAssert(this.id, this.scope, reason, conds, options.when));
  }

  /** Validated read and write parts from side builders, appended in call order (see `readPart`, `writePart`). */
  include(...parts: GrantPart[]): GrantedStatement[] {
    personalOrgOnlyInserts(this.purpose, 'raw parts');
    // A part is checked text, not typed by table: it cannot carry a key's template limits.
    this.#limitedRefused ||= this.#keyed;
    return parts.map((p) =>
      this.#push(
        buildPart(this.id, this.scope, p, {
          holder: this.#pin !== undefined,
          // Parts reach tables the builder does not type, so the grant must list its tables.
          onWrite: (t) => assertTableAllowed(this.purpose, this.#tables, t, 'change', true),
        }),
      ),
    );
  }

  /** Position of a statement in the results of `commit()`. */
  indexOf(s: GrantedStatement): number {
    const at = this.#statements.indexOf(s);
    if (at < 0)
      throw new AuthorityError('GRANT_FOREIGN_STATEMENT', 'The statement is not in this grant.');
    return at;
  }

  /** Bound-parameter and byte counts of the grant insert and each write, for the corpus test. */
  inspect(): { grant: Size; writes: Size[] } {
    const size = (b: BuiltStatement): Size => ({ params: b.params.length, bytes: b.sql.length });
    return {
      grant: size(this.#insert()),
      writes: this.#statements.map((s) => size(builtOf(s))),
    };
  }

  /** Grant insert, writes, grant delete. Reached only through `grantedBatch`. */
  #prepare(): D1PreparedStatement[] {
    if (this.#committed)
      throw new AuthorityError('GRANT_ALREADY_COMMITTED', 'This grant was committed.');
    const insert = this.#insert();
    this.#committed = true;
    const writes = this.#statements.map((s) => {
      const { sql, params } = builtOf(s);
      return exactStmt(this.#db, sql, params);
    });
    return [
      exactStmt(this.#db, insert.sql, insert.params),
      ...writes,
      exactStmt(this.#db, 'DELETE FROM authority_grants WHERE id = ?', [this.id]),
    ];
  }

  /** @internal Maps a refusal to the HTTP error; other errors are returned unchanged. */
  translate(error: unknown): unknown {
    return translateDenial(error, this.principal, this.#input.codes);
  }
  /** @internal After a `limit` refusal: the limit this grant's checks ran into, or null. */
  limitHit = (): Promise<LimitHit | null> =>
    limitHitOf(this.#db, this.scope, this.principal, this.#now, this.#input.checks ?? []);

  /** Runs the grant and its writes as one D1 batch. Results are for the writes, in order. */
  async commit(): Promise<D1Result[]> {
    return (await grantedBatch(this.#db, [this]))[0] ?? [];
  }

  /** `commit()` with a retention receipt first in the same transaction: a refusal undoes it, and its absence refuses. */
  async commitAfter(receipt: ReceiptStatement): Promise<D1Result[]> {
    assertReceipt(receipt);
    return (await grantedBatchWith(this.#db, [this], [], [receipt])).grants[0] ?? [];
  }

  /** `commit()` plus reads (`afterRead`) after the release, in the same transaction: they see its writes. */
  async commitWith(
    after: readonly AfterRead[],
  ): Promise<{ writes: D1Result[]; after: D1Result[] }> {
    const r = await grantedBatchWith(this.#db, [this], after);
    return { writes: r.grants[0] ?? [], after: r.after };
  }
}

/** Test-only: the prepared statements of a grant, to inspect or break a batch. */
export { prepareOf as prepareGrantForTest } from './authority-batch.ts';

/** A tenant, API-key, scanner or platform-admin grant. `system:` principals use `jobGrant`. */
export function grant(ctx: ServiceContext, input: GrantInput): Grant {
  if (input.principal.kind === 'system')
    throw new AuthorityError('GRANT_NOT_JOB', 'System grants come from jobGrant().');
  const scope = scopeOf(input);
  assertDeferredContext(hasFullJobAuthority(ctx), input);
  const p = input.principal;
  const full = { ...input, ...(p.kind === 'holder' ? { target: p.passId } : {}), via: ctx.via };
  return new Grant(ctx.env.DB, ctx.ids.token(), scope, full, ctx.clock.now());
}

/** Only a context built by `createJobContext` (queue, cron, workflow) can mint a `system:` grant. */
export function jobGrant(ctx: ServiceContext, input: JobGrantInput): Grant {
  assertJobGrantAllowed(ctx.job, input.purpose);
  const full = jobGrantInputOf(input);
  return new Grant(ctx.env.DB, ctx.ids.token(), scopeOf(full), full, ctx.clock.now());
}
