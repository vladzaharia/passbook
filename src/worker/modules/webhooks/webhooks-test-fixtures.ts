import type { Mode } from '../../../shared/contracts/common.ts';
import { all, first, run } from '../../platform/db.ts';

let counter = 0;

export interface EndpointSeed {
  orgId: string;
  mode?: Mode;
  eventTypes?: string[];
  templateIds?: string[] | null;
  status?: 'active' | 'paused' | 'disabled';
  url?: string;
}

/** A raw endpoint row, as the migration allows it. Tests only: the app writes through a grant. */
export async function seedEndpoint(db: D1Database, seed: EndpointSeed): Promise<string> {
  const id = `ep-${++counter}-${Math.random().toString(36).slice(2, 8)}`;
  const status = seed.status ?? 'active';
  await run(
    db,
    `INSERT INTO webhook_endpoints (id, org_id, mode, url, event_types, template_ids, api_version,
       status, disabled_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, '2026-12-01', ?, ?, 1, 1)`,
    [
      id,
      seed.orgId,
      seed.mode ?? 'live',
      seed.url ?? `https://hooks.example.com/${id}`,
      JSON.stringify(seed.eventTypes ?? ['pass.issued']),
      seed.templateIds ? JSON.stringify(seed.templateIds) : null,
      status,
      status === 'disabled' ? 1 : null,
    ],
  );
  return id;
}

export const ALL_TYPES = [
  'pass.issued',
  'pass.updated',
  'pass.voided',
  'pass.unvoided',
  'pass.removed',
  'pass.restored',
  'pass.installed',
  'pass.uninstalled',
  'pass.scanned',
  'pass.scan_refused',
  'pass.scan_undone',
  'push.failed',
  'email.failed',
];

export interface FeedRowOut {
  seq: number;
  event_id: string;
  org_id: string;
  mode: string;
  pass_id: string;
  type: string;
  kind: string;
  device_count: number | null;
  data: string;
}

export const feedOf = (db: D1Database, passId: string) =>
  all<FeedRowOut>(
    db,
    `SELECT seq, event_id, org_id, mode, pass_id, type, kind, device_count, data
     FROM event_feed WHERE pass_id = ? ORDER BY seq`,
    [passId],
  );

export const deliveriesOf = (db: D1Database, endpointId: string) =>
  all<{ event_seq: number; org_id: string; mode: string; state: string }>(
    db,
    'SELECT event_seq, org_id, mode, state FROM webhook_deliveries WHERE endpoint_id = ? ORDER BY event_seq',
    [endpointId],
  );

export const countOf = async (db: D1Database, table: string, where = '1 = 1') =>
  (await first<{ n: number }>(db, `SELECT count(*) AS n FROM ${table} WHERE ${where}`))?.n ?? 0;
