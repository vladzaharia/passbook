import type { z } from 'zod';
import type { ConnectionPreviewSchema } from '@/shared/contracts/connection-preview.ts';
import type { ConnectionSchema, VoidRule } from '@/shared/contracts/connections.ts';
import type { PassImportDto } from '@/shared/contracts/pass-imports.ts';
import { optionOf } from '@/shared/issuing/matcher-values.ts';
import {
  type ImportPlan,
  type MatchRow,
  type MatchState,
  planOfState,
  SKIP,
  stateOfImport,
} from '../passes/import/match-model.ts';

type Preview = z.infer<typeof ConnectionPreviewSchema>;
type Conn = Pick<z.infer<typeof ConnectionSchema>, 'mapping' | 'holderEmailField' | 'voidWhen'>;
type Mapping = NonNullable<Conn['mapping']>;

/** The source's fields as the columns of a file, so the import's rows can show them. */
export const columnsOf = (p: Preview) =>
  p.columns.map(({ pointer, label, samples }) => ({ pointer, label, samples }));

const skipped = (rules: readonly VoidRule[], pointer: string | undefined): Set<string> =>
  new Set(
    rules.flatMap((r) =>
      r.op === 'in' && r.from === pointer ? (r.values ?? []).map((v) => String(v)) : [],
    ),
  );

/** A choice row's values: what the records hold, with the option each becomes or "Don't issue". */
function withValues(row: MatchRow, conn: Conn, preview: Preview): MatchRow {
  const pointer = row.from[0];
  const col = preview.columns.find((c) => c.pointer === pointer);
  if (row.kind !== 'choice' || row.from.length !== 1 || !col || col.values.length === 0) return row;
  const map = conn.mapping?.[row.target]?.transform?.options?.map as
    | Record<string, string>
    | undefined;
  const skip = skipped(conn.voidWhen, pointer);
  return {
    ...row,
    counted: true,
    values: col.values.map((v) => {
      const key = map && Object.keys(map).find((k) => k.toLowerCase() === v.value.toLowerCase());
      const to = skip.has(v.value)
        ? SKIP
        : ((key === undefined ? undefined : map?.[key]) ??
          row.values.find((x) => x.value === v.value)?.to ??
          optionOf(v.value, row.options));
      return { value: v.value, count: v.count, to: to ?? null };
    }),
  };
}

/** The editable rows: the saved mapping over the matcher's suggestion for the template. */
export function stateOfConnection(conn: Conn, preview: Preview, schema: unknown): MatchState {
  const saved = Object.keys(conn.mapping ?? {}).length > 0 || Boolean(conn.holderEmailField);
  const plan: ImportPlan | null = saved
    ? {
        mapping: (conn.mapping ?? {}) as ImportPlan['mapping'],
        holderEmail: conn.holderEmailField ? { from: conn.holderEmailField } : null,
        externalId: null,
        match: 'none',
        keepManual: false,
        save: false,
      }
    : null;
  const base = stateOfImport(
    { columns: columnsOf(preview), plan: plan as PassImportDto['plan'], mapping: undefined },
    schema,
  );
  return {
    ...base,
    find: 'none',
    rows: base.rows.map((r) => withValues(r, conn, preview)),
  };
}

export interface ConnectionMap {
  mapping: Mapping;
  holderEmailField: string;
  voidWhen: VoidRule[];
  /** Row key to message. */
  errors: Record<string, string>;
}

/**
 * The connection fields for the rows. Entries the rows do not cover stay as they are, and a transform
 * the rows cannot show (trim, a constant) stays while the source field does.
 */
export function mapOfState(state: MatchState, conn: Conn): ConnectionMap {
  const { plan, errors } = planOfState(state, { keepManual: false, save: false });
  const targets = new Set(state.rows.filter((r) => r.role === 'input').map((r) => r.target));
  const mapping: Mapping = {};
  for (const [key, entry] of Object.entries(conn.mapping ?? {}))
    if (!targets.has(key)) mapping[key] = entry;
  for (const [key, entry] of Object.entries(plan?.mapping ?? {})) {
    const was = conn.mapping?.[key];
    mapping[key] =
      !entry.transform && was?.transform && was.from === entry.from
        ? was
        : (entry as Mapping[string]);
  }
  const choices = state.rows.filter((r) => r.kind === 'choice' && r.from.length === 1);
  const own = new Set(choices.map((r) => r.from[0]));
  const rules = conn.voidWhen.filter((r) => !(r.op === 'in' && own.has(r.from)));
  for (const r of choices) {
    const values = r.values.filter((v) => v.to === SKIP).map((v) => v.value);
    if (values.length && r.from[0]) rules.push({ from: r.from[0], op: 'in', values });
  }
  return {
    mapping,
    holderEmailField: plan?.holderEmail?.from ?? conn.holderEmailField ?? '',
    voidWhen: rules,
    errors,
  };
}
