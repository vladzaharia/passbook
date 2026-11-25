import type { PassPrint } from '../../../shared/contracts/prints.ts';
import { all, first } from '../../platform/db.ts';

interface Row {
  id: string;
  pass_id: string;
  generation: number;
  status: PassPrint['status'];
  pass_version: number | null;
  paper_hash: string | null;
  created_at: number;
  voided_at: number | null;
  void_cause: string | null;
}

const COLUMNS =
  'id, pass_id, generation, status, pass_version, paper_hash, created_at, voided_at, void_cause';

/** Stale: active, made from a known drawing, and the pass now draws something else. `hash` is the current drawing's. */
const toPrint = (r: Row, hash: string | null): PassPrint => ({
  id: r.id,
  passId: r.pass_id,
  generation: r.generation,
  status: r.status,
  passVersion: r.pass_version,
  stale: r.status === 'active' && r.paper_hash !== null && hash !== null && r.paper_hash !== hash,
  createdAt: r.created_at,
  voidedAt: r.voided_at,
  voidCause: r.void_cause,
});

/** A pass's prints, newest first. Never carries a code or its hash. */
export async function listPrints(
  db: D1Database,
  passId: string,
  hash: string | null = null,
): Promise<PassPrint[]> {
  const rows = await all<Row>(
    db,
    `SELECT ${COLUMNS} FROM pass_prints WHERE pass_id = ? ORDER BY generation DESC LIMIT 200`,
    [passId],
  );
  return rows.map((r) => toPrint(r, hash));
}

export async function activePrint(
  db: D1Database,
  passId: string,
  hash: string | null = null,
): Promise<PassPrint | null> {
  const r = await first<Row>(
    db,
    `SELECT ${COLUMNS} FROM pass_prints WHERE pass_id = ? AND status = 'active'`,
    [passId],
  );
  return r ? toPrint(r, hash) : null;
}

export async function printById(
  db: D1Database,
  passId: string,
  id: string,
  hash: string | null = null,
): Promise<PassPrint | null> {
  const r = await first<Row>(
    db,
    `SELECT ${COLUMNS} FROM pass_prints WHERE pass_id = ? AND id = ?`,
    [passId, id],
  );
  return r ? toPrint(r, hash) : null;
}

/**
 * Whether the pass's newest print ended without a reprint or a void by someone: the pass was voided, or the
 * credential moved (transfer, new code), so it needs a new print for the same holder. `holder_change` stays out.
 */
export async function endedForHolder(db: D1Database, passId: string): Promise<boolean> {
  const r = await first<{ void_cause: string | null }>(
    db,
    'SELECT void_cause FROM pass_prints WHERE pass_id = ? ORDER BY generation DESC LIMIT 1',
    [passId],
  );
  return (
    r?.void_cause === 'pass_voided' || r?.void_cause === 'transfer' || r?.void_cause === 'new_code'
  );
}

export async function nextGeneration(db: D1Database, passId: string): Promise<number> {
  const r = await first<{ g: number | null }>(
    db,
    'SELECT MAX(generation) AS g FROM pass_prints WHERE pass_id = ?',
    [passId],
  );
  return (r?.g ?? 0) + 1;
}

/** The pinned template version's manifest JSON; null when the version is gone or unreadable. */
export async function manifestOf(
  db: D1Database,
  templateId: string,
  version: string,
): Promise<Record<string, unknown> | null> {
  const r = await first<{ manifest: string | null }>(
    db,
    'SELECT manifest FROM template_versions WHERE template_id = ? AND version = ?',
    [templateId, version],
  );
  if (!r?.manifest) return null;
  // Stored versions are validated JSON; a parse failure is corruption and should surface.
  const parsed: unknown = JSON.parse(r.manifest);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

/** Which of these prints are active; `ids` holds at most 90. */
export async function activePrintIds(db: D1Database, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await all<{ id: string }>(
    db,
    `SELECT id FROM pass_prints WHERE status = 'active' AND id IN (${ids.map(() => '?').join(',')})`,
    ids,
  );
  return new Set(rows.map((r) => r.id));
}
