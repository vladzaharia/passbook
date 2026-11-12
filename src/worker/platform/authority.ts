// The only module that builds guarded writes. Contract: docs/design/authority-epochs.md section 1.2.
import { type AuditRow, type AuditWhen, buildAudit } from './authority-audit.ts';
import { grantedBatch, grantedBatchWith, prepareOf, registerPrepare } from './authority-batch.ts';
import type { Check } from './authority-checks.ts';
import { buildAssert, type GrantCond } from './authority-cond.ts';
import { AuthorityError } from './authority-error.ts';
import { identifier } from './authority-expr.ts';
import {
  assertDeferredContext,
  authorityDenial,
  builtOf,
  type GrantedStatement,
  type GrantInput,
  grantInsert,
  jobPrincipal,
  newGrantedStatement,
  scopeOf,
} from './authority-granted.ts';
import { assertUnguarded, buildPart, type GrantPart, writeTargets } from './authority-include.ts';
import {
  buildInsertJoined,
  buildJoined,
  type InsertJoinedOptions,
  type JoinedOptions,
} from './authority-joined.ts';
import type { GrantScope, Mode, Principal } from './authority-principal.ts';
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
import { authorityDenied, type DenyReason } from './errors.ts';
import { hasJobAuthority } from './job-authority.ts';
import type { ServiceContext } from './service-context.ts';

export type { AuditRow } from './authority-audit.ts';
export { grantedBatch } from './authority-batch.ts';
export type { GrantedStatement, GrantInput } from './authority-granted.ts';
export { authorityDenial, sweepLeakedGrants } from './authority-granted.ts';

const JOB_PURPOSE = /\.job\./;

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
    this.#pin = input.principal.kind === 'holder' ? input.principal.passId : undefined;
    this.#tables = input.tables ? new Set(input.tables.map(identifier)) : undefined;
    this.#insert();
  }

  /** Built at prepare time: `require: 'one'` writes add their lineage checks to it. */
  #insert(): BuiltStatement {
    return grantInsert(this.id, this.scope, this.#input, this.#lineage, this.#now);
  }

  /** A write outside the grant's `tables` is a programming error. */
  #allow(table: string): string {
    if (this.#tables && !this.#tables.has(table.toLowerCase()))
      throw new AuthorityError(
        'GRANT_TABLE_NOT_ALLOWED',
        `${this.purpose} does not write ${table}.`,
      );
    return table;
  }

  /** Parts and unguarded writes reach tables the builder does not type, so the grant must list its tables. */
  #need(table: string): string {
    if (!this.#tables)
      throw new AuthorityError(
        'GRANT_TABLE_NOT_ALLOWED',
        `${this.purpose} lists no tables: a grant that includes writes names them.`,
      );
    return this.#allow(table);
  }

  #push(built: BuiltStatement): GrantedStatement {
    if (this.#committed)
      throw new AuthorityError('GRANT_ALREADY_COMMITTED', 'This grant was committed.');
    assertBudget(built.sql, built.params, built.read ? PARAM_BUDGET : WRITE_PARAM_BUDGET);
    if (built.lineage) this.#lineage.push(built.lineage);
    const statement = newGrantedStatement(this.id, built);
    this.#statements.push(statement);
    return statement;
  }

  update(table: string, options: WriteOptions): GrantedStatement {
    return this.#push(buildUpdate(this.id, this.scope, this.#allow(table), options, this.#pin));
  }

  delete(table: string, options: Omit<WriteOptions, 'set' | 'inc'>): GrantedStatement {
    return this.#push(buildDelete(this.id, this.scope, this.#allow(table), options, this.#pin));
  }

  insertSelect(
    table: string,
    columns: string[],
    values: SqlValue[],
    options?: InsertOptions,
  ): GrantedStatement {
    return this.#push(
      buildInsertSelect(
        this.id,
        this.scope,
        this.#allow(table),
        columns,
        values,
        options,
        this.#pin,
      ),
    );
  }

  /** Insert, or change the existing row at the table's fixed conflict target (see `UpsertOptions`). */
  upsert(
    table: string,
    columns: string[],
    values: SqlValue[],
    options: UpsertOptions,
  ): GrantedStatement {
    return this.#push(
      buildUpsert(this.id, this.scope, this.#allow(table), columns, values, options, this.#pin),
    );
  }

  /** Update or delete an org-less child through a declared foreign key to a parent in the tenant. */
  joined(table: string, options: JoinedOptions): GrantedStatement {
    return this.#push(buildJoined(this.id, this.scope, this.#allow(table), options, this.#pin));
  }

  /** Insert an org-less child under parents in the tenant; the parent rows supply its foreign keys. */
  insertJoined(table: string, options: InsertJoinedOptions): GrantedStatement {
    return this.#push(
      buildInsertJoined(this.id, this.scope, this.#allow(table), options, this.#pin),
    );
  }

  /** Adds statements built elsewhere for this grant (hooks must return these, never run after commit). */
  add(...statements: GrantedStatement[]): void {
    for (const s of statements) {
      if (builtOf(s).grantId !== this.id)
        throw new AuthorityError(
          'GRANT_FOREIGN_STATEMENT',
          'A statement belongs to a different grant.',
        );
      const built = builtOf(s);
      assertBudget(built.sql, built.params, built.read ? PARAM_BUDGET : WRITE_PARAM_BUDGET);
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
    return this.#push(buildAudit(this.id, this.scope, entry, when));
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
    return parts.map((p) =>
      this.#push(
        buildPart(this.id, this.scope, p, {
          holder: this.#pin !== undefined,
          onWrite: (t) => this.#need(t),
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

  /**
   * A write to a table the builder does not guard that still commits only in this grant's batch. The SQL
   * must carry the grant-row predicate (`authority_grants`) and may not write a guarded, authority or
   * append-only table. Like every statement it runs only after `add()`.
   * @deprecated Use `include(writePart(...))`: it adds itself, validates markers and takes the tenant from the grant.
   */
  unguarded(sql: string, params: SqlValue[]): GrantedStatement {
    assertUnguarded(sql);
    for (const table of writeTargets(sql)) this.#need(table);
    return newGrantedStatement(this.id, { sql, params });
  }

  /** Bound-parameter and byte counts of the grant insert and each write, for the corpus test. */
  inspect(): {
    grant: { params: number; bytes: number };
    writes: { params: number; bytes: number }[];
  } {
    const size = (b: BuiltStatement) => ({ params: b.params.length, bytes: b.sql.length });
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
    const reason = authorityDenial(error);
    if (reason === null) return error;
    return authorityDenied(reason, {
      scanner: this.principal.kind === 'scanner',
      ...(this.#input.codes ? { codes: this.#input.codes } : {}),
    });
  }

  /** Runs the grant and its writes as one D1 batch. Results are for the writes, in order. */
  async commit(): Promise<D1Result[]> {
    return (await grantedBatch(this.#db, [this]))[0] ?? [];
  }

  /** `commit()` with plain read statements appended after the release, in the same transaction. */
  async commitWith(
    after: D1PreparedStatement[],
  ): Promise<{ writes: D1Result[]; after: D1Result[] }> {
    const r = await grantedBatchWith(this.#db, [this], after);
    return { writes: r.grants[0] ?? [], after: r.after };
  }
}

/** Test-only: the prepared statements of a grant, to inspect or break a batch. */
export function prepareGrantForTest(g: Grant): D1PreparedStatement[] {
  return prepareOf(g);
}

/** A tenant, API-key, scanner or platform-admin grant. `system:` principals use `jobGrant`. */
export function grant(ctx: ServiceContext, input: GrantInput): Grant {
  if (input.principal.kind === 'system')
    throw new AuthorityError('GRANT_NOT_JOB', 'System grants come from jobGrant().');
  const scope = scopeOf(input);
  assertDeferredContext(hasJobAuthority(ctx), input);
  const p = input.principal;
  const full = p.kind === 'holder' ? { ...input, target: p.passId } : input;
  return new Grant(ctx.env.DB, ctx.ids.token(), scope, full, ctx.clock.now());
}

export interface JobGrantInput extends Omit<GrantInput, 'principal'> {
  job: string;
  orgId?: string;
  mode?: Mode;
  orgAccessRevision?: number;
}

/** Only a context built by `createJobContext` (queue, cron, workflow) can mint a `system:` grant. */
export function jobGrant(ctx: ServiceContext, input: JobGrantInput): Grant {
  if (!hasJobAuthority(ctx))
    throw new AuthorityError('GRANT_NOT_JOB', 'jobGrant needs a queue, cron or workflow context.');
  if (!JOB_PURPOSE.test(input.purpose))
    throw new AuthorityError(
      'GRANT_BAD_PURPOSE',
      'A job grant purpose names a job: <scope>.job.<name>.',
    );
  const { job, orgId, mode, orgAccessRevision, ...rest } = input;
  const principal = jobPrincipal({ job, orgId, mode, orgAccessRevision });
  const full = { ...rest, principal };
  return new Grant(ctx.env.DB, ctx.ids.token(), scopeOf(full), full, ctx.clock.now());
}
