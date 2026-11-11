import { first, type SqlValue, stmt } from '../../platform/db.ts';
import { stagedOutputQuery } from './repo-output-predicate-stages.ts';
import { packScanPredicate, scanSecretSlots } from './repo-secret-binds.ts';

export interface OutputPredicate {
  sql: string;
  params: readonly SqlValue[];
}

const outputParts = new WeakMap<
  OutputPredicate,
  { sql: string; params: readonly SqlValue[]; parts: readonly OutputPredicate[] }
>();

/** Remember trusted builder-owned boundaries without parsing arbitrary predicate SQL. */
export function andOutputPredicates(parts: readonly OutputPredicate[]): OutputPredicate {
  const captured = parts.map((part) => ({ sql: part.sql, params: [...part.params] }));
  const sql = captured.map((part) => `(${part.sql})`).join(' AND ') || '1';
  const params = captured.flatMap((part) => part.params);
  const predicate = { sql, params };
  const flattened = parts
    .flatMap(outputPredicateParts)
    .map((part) => ({ sql: part.sql, params: [...part.params] }));
  outputParts.set(predicate, { sql, params: [...params], parts: flattened });
  return predicate;
}

/** Fall back to the whole predicate if a composed value was subsequently changed. */
export function outputPredicateParts(predicate: OutputPredicate): readonly OutputPredicate[] {
  const captured = outputParts.get(predicate);
  return captured &&
    captured.parts.length > 0 &&
    captured.sql === predicate.sql &&
    captured.params.length === predicate.params.length &&
    captured.params.every((value, index) => Object.is(value, predicate.params[index]))
    ? captured.parts
    : [predicate];
}

const packedSource = 'EXISTS (SELECT 1 FROM (SELECT json(?) AS data) output_bound_snapshot WHERE ';
const stagedSource =
  'EXISTS (SELECT 1 FROM (SELECT json(?) AS data) output_bound_snapshot JOIN (SELECT 1) ON (';

/** Pack only nonsecret binds; labeled scalar slots remain separate through nested fences. */
export function packOutputPredicate(input: OutputPredicate): OutputPredicate {
  const packed = packScanPredicate(input.sql, input.params, 'output_bound_snapshot');
  if (!packed?.sql.startsWith(packedSource) || !packed.sql.endsWith(')'))
    return { sql: '0', params: [] };
  const expression = packed.sql.slice(packedSource.length, -1);
  return { sql: `${stagedSource}${expression}))`, params: packed.params };
}

/** Extract only a freshly packed expression for callers staging its metadata row. */
export function packedOutputExpression(fence: OutputPredicate): string | null {
  return fence.sql.startsWith(stagedSource) && fence.sql.endsWith('))')
    ? fence.sql.slice(stagedSource.length, -2)
    : null;
}

interface OutputGroup {
  sql: string;
  entries: { index: number; data: string }[];
  bytes: number;
}

function outputQuery(groups: readonly OutputGroup[]): OutputPredicate {
  return {
    sql: `SELECT ${groups
      .map(
        (group, index) =>
          `(SELECT json_group_array(CASE WHEN (${group.sql}) THEN 1 ELSE 0 END)
        FROM json_each(?) j) AS result_${index}`,
      )
      .join(', ')}`,
    // Each entry is already a JSON array from packedPredicate; avoid escaping it a second time.
    params: groups.map((group) => `[${group.entries.map((entry) => entry.data).join(',')}]`),
  };
}

function collectResults(
  row: Record<string, string> | undefined | null,
  groups: readonly OutputGroup[],
  output: boolean[],
): void {
  groups.forEach((group, index) => {
    const raw = row?.[`result_${index}`];
    if (typeof raw !== 'string') return;
    const values: unknown = JSON.parse(raw);
    if (!Array.isArray(values)) return;
    group.entries.forEach((entry, offset) => {
      output[entry.index] = values[offset] === 1;
    });
  });
}

/** Split large snapshots while retaining structurally labeled scalar binds. */
function largeOutputPredicate(
  input: OutputPredicate,
  encoder: TextEncoder,
): OutputPredicate | null {
  const slots = scanSecretSlots(input.sql, input.params.length);
  if (!slots) return null;
  const segments: SqlValue[][] = [];
  const secrets: SqlValue[] = [];
  let segment: SqlValue[] = [];
  let size = 2;
  let expression = '';
  let previous = 0;
  for (const [index, slot] of slots.entries()) {
    const value = input.params[index];
    expression += input.sql.slice(previous, slot.offset);
    if (slot.label) {
      expression += '?';
      secrets.push(value);
    } else {
      if (
        value instanceof ArrayBuffer ||
        value instanceof Uint8Array ||
        (typeof value === 'number' && !Number.isFinite(value))
      )
        return null;
      const encoded = JSON.stringify(value ?? null);
      const bytes = encoder.encode(encoded).byteLength + 1;
      if (bytes > 1_900_000) return null;
      if (segment.length && size + bytes > 750_000) {
        segments.push(segment);
        segment = [];
        size = 2;
      }
      expression += `json_extract(output_segments.segment_${segments.length},'$[${segment.length}]')`;
      segment.push(value);
      size += bytes;
    }
    previous = slot.offset + 1;
  }
  expression += input.sql.slice(previous);
  if (segment.length) segments.push(segment);
  if (!segments.length || segments.length + secrets.length > 90) return null;
  const source = segments.map((_, n) => `json(?) AS segment_${n}`).join(', ');
  const sql = `EXISTS (SELECT 1 FROM (SELECT ${source}) output_segments WHERE ${expression})`;
  if (encoder.encode(sql).byteLength > 90_000) return null;
  return { sql, params: [...segments.map((values) => JSON.stringify(values)), ...secrets] };
}

/** Split oversized labeled text into scalar pieces without breaking a surrogate pair. */
function splitLargeOutputScalars(
  input: OutputPredicate,
  encoder: TextEncoder,
): OutputPredicate | null {
  const slots = scanSecretSlots(input.sql, input.params.length);
  if (!slots) return null;
  const params: SqlValue[] = [];
  let expression = '';
  let previous = 0;
  for (const [index, slot] of slots.entries()) {
    const value = input.params[index];
    expression += input.sql.slice(previous, slot.offset);
    if (slot.label && typeof value === 'string' && encoder.encode(value).byteLength > 1_900_000) {
      const marker = `?/* scan-ephemeral-${slot.label} */`;
      const chunks: string[] = [];
      for (let start = 0; start < value.length; ) {
        let end = Math.min(start + 500_000, value.length);
        const last = value.charCodeAt(end - 1);
        const next = value.charCodeAt(end);
        if (
          end < value.length &&
          last >= 0xd800 &&
          last <= 0xdbff &&
          next >= 0xdc00 &&
          next <= 0xdfff
        )
          end--;
        chunks.push(value.slice(start, end));
        if (chunks.length > 90) return null;
        start = end;
      }
      expression += `(${chunks.map(() => marker).join(' || ')})`;
      params.push(...chunks);
      previous = slot.offset + marker.length;
    } else {
      expression += '?';
      params.push(value);
      previous = slot.offset + 1;
    }
  }
  return { sql: expression + input.sql.slice(previous), params };
}

/** Bind-bounded boolean for output SELECTs and guarded writes in the same transaction. */
export function boundOutputPredicate(input: OutputPredicate): OutputPredicate {
  const encoder = new TextEncoder();
  let source = input;
  let packed = packOutputPredicate(source);
  if (
    packed.params
      .slice(1)
      .some((value) => typeof value === 'string' && encoder.encode(value).byteLength > 1_900_000)
  ) {
    const split = splitLargeOutputScalars(source, encoder);
    if (!split) return { sql: '0', params: [] };
    source = split;
    packed = packOutputPredicate(source);
  }
  // Reserve room for a caller's additional same-statement scalar fences.
  if (packed.params.length > 90) return { sql: '0', params: [] };
  for (const value of packed.params.slice(1)) {
    const bytes =
      typeof value === 'string'
        ? encoder.encode(value).byteLength
        : value instanceof ArrayBuffer
          ? value.byteLength
          : value instanceof Uint8Array
            ? value.byteLength
            : 0;
    if (bytes > 1_900_000) return { sql: '0', params: [] };
  }
  const data = typeof packed.params[0] === 'string' ? packed.params[0] : '[]';
  if (encoder.encode(data).byteLength > 1_000_000)
    return largeOutputPredicate(source, encoder) ?? { sql: '0', params: [] };
  return encoder.encode(packed.sql).byteLength <= 90_000 ? packed : { sql: '0', params: [] };
}

/** One bind-bounded authority SELECT for callers with additional same-transaction reads. */
export function outputPredicateStmt(
  db: D1Database,
  predicate: OutputPredicate,
): D1PreparedStatement {
  const bound = boundOutputPredicate(predicate);
  const staged =
    bound.sql === '0'
      ? null
      : stagedOutputQuery(
          outputPredicateParts(predicate),
          boundOutputPredicate,
          packedOutputExpression,
        );
  if (staged) return stmt(db, staged.sql, staged.params);
  return stmt(db, `SELECT CASE WHEN (${bound.sql}) THEN 1 ELSE 0 END AS authorized`, bound.params);
}

type OutputTask =
  | { query: OutputPredicate; groups: OutputGroup[] }
  | { query: OutputPredicate; index: number };

function collectTask(
  row: Record<string, string | number> | undefined | null,
  task: OutputTask,
  output: boolean[],
): void {
  if ('index' in task) output[task.index] = row?.result_0 === 1;
  else collectResults(row as Record<string, string> | undefined | null, task.groups, output);
}

/** Evaluate self-contained predicates in one D1 read transaction, preserving input order. */
export async function outputPredicatesCurrent(
  db: D1Database,
  inputs: readonly OutputPredicate[],
): Promise<boolean[]> {
  if (!inputs.length) return [];
  const encoder = new TextEncoder();
  const groups: OutputGroup[] = [];
  const large: OutputTask[] = [];
  const lastBySql = new Map<string, OutputGroup>();
  for (const [index, input] of inputs.entries()) {
    const predicate = packOutputPredicate(input);
    // Identical SQL shapes share one expression while each row retains its own snapshot.
    const sql = predicate.sql.replace('json(?) AS data', 'json(j.value) AS data');
    const data = typeof predicate.params[0] === 'string' ? predicate.params[0] : '[]';
    const bytes = encoder.encode(data).byteLength + 1;
    if (bytes > 1_000_000 || predicate.params.length > 1) {
      const bounded = boundOutputPredicate(input);
      if (bounded.sql !== '0')
        large.push({
          query: { sql: `SELECT (${bounded.sql}) AS result_0`, params: bounded.params },
          index,
        });
      continue;
    }
    if (encoder.encode(sql).byteLength + 128 > 90_000) continue;
    let group = lastBySql.get(sql);
    if (!group || group.entries.length >= 80 || group.bytes + bytes > 1_000_000) {
      group = { sql, entries: [], bytes: 2 };
      groups.push(group);
      lastBySql.set(sql, group);
    }
    group.entries.push({ index, data });
    group.bytes += bytes;
  }

  // Bound query text and bind count as well as the size of each packed JSON array.
  const batches: OutputGroup[][] = [];
  let batch: OutputGroup[] = [];
  let size = 7;
  for (const group of groups) {
    const bytes = encoder.encode(group.sql).byteLength + 128;
    if (batch.length && (batch.length >= 80 || size + bytes > 90_000)) {
      batches.push(batch);
      batch = [];
      size = 7;
    }
    batch.push(group);
    size += bytes;
  }
  if (batch.length) batches.push(batch);
  const output = Array<boolean>(inputs.length).fill(false);
  const tasks: OutputTask[] = [
    ...batches.map((group) => ({ query: outputQuery(group), groups: group })),
    ...large,
  ];
  if (tasks.length === 1) {
    const task = tasks[0];
    if (task === undefined) throw new Error('Missing output predicate task');
    collectTask(
      await first<Record<string, string | number>>(db, task.query.sql, task.query.params),
      task,
      output,
    );
  } else if (tasks.length > 1) {
    const results = await db.batch(tasks.map(({ query }) => stmt(db, query.sql, query.params)));
    tasks.forEach((task, index) => {
      collectTask(
        results[index]?.results?.[0] as Record<string, string | number> | undefined,
        task,
        output,
      );
    });
  }
  return output;
}
