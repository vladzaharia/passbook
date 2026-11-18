import type { Mode } from '../../../shared/contracts/common.ts';
import { first } from '../../platform/db.ts';

const DAY = 24 * 60 * 60 * 1000;

/** The link a presented token names, with what the public path needs to decide whether it is open. */
export interface PublicLink {
  id: string;
  orgId: string;
  orgName: string;
  orgActive: boolean;
  mode: Mode;
  templateId: string;
  templateActive: boolean;
  generation: number;
  enabled: boolean;
  nameInput: string | null;
  askEmail: boolean;
  dailyLimit: number;
}

interface LinkRaw {
  id: string;
  org_id: string;
  org_name: string;
  org_status: string;
  mode: Mode;
  template_id: string;
  template_status: string;
  generation: number;
  enabled: number;
  name_input: string | null;
  ask_email: number;
  daily_limit: number;
}

/** `macs` are the token's lookup MACs (the current root's, and the previous one's mid-rotation). */
export async function linkByToken(
  db: D1Database,
  macs: readonly [string, string],
): Promise<PublicLink | null> {
  const r = await first<LinkRaw>(
    db,
    `SELECT jl.id, jl.org_id, o.name AS org_name, o.status AS org_status, jl.mode, jl.template_id,
        t.status AS template_status, jl.generation, jl.enabled, jl.name_input, jl.ask_email, jl.daily_limit
      FROM join_links jl
      JOIN orgs o ON o.id = jl.org_id
      JOIN templates t ON t.id = jl.template_id
      WHERE jl.token IN (?, ?)`,
    [macs[0], macs[1]],
  );
  return r
    ? {
        id: r.id,
        orgId: r.org_id,
        orgName: r.org_name,
        orgActive: r.org_status === 'active',
        mode: r.mode,
        templateId: r.template_id,
        templateActive: r.template_status === 'active',
        generation: r.generation,
        enabled: r.enabled === 1,
        nameInput: r.name_input,
        askEmail: r.ask_email === 1,
        dailyLimit: r.daily_limit,
      }
    : null;
}

export interface DeviceIssue {
  passId: string;
  fieldsHash: string | null;
  createdAt: number;
}

/** The card this device got from this link in the last 24 hours, if any (newest). */
export async function deviceIssue(
  db: D1Database,
  linkId: string,
  deviceKey: string,
  now: number,
): Promise<DeviceIssue | null> {
  const r = await first<{ pass_id: string; fields_hash: string | null; created_at: number }>(
    db,
    `SELECT pass_id, fields_hash, created_at FROM join_issues
      WHERE device_key = ? AND link_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1`,
    [deviceKey, linkId, now - DAY],
  );
  return r ? { passId: r.pass_id, fieldsHash: r.fields_hash, createdAt: r.created_at } : null;
}

/** Cards an org's links made in the last rolling 24 hours in one mode (the count the grant caps against). */
export async function orgIssuedToday(
  db: D1Database,
  orgId: string,
  mode: Mode,
  now: number,
): Promise<number> {
  const r = await first<{ n: number }>(
    db,
    'SELECT COUNT(*) AS n FROM join_issues WHERE org_id = ? AND mode = ? AND created_at > ?',
    [orgId, mode, now - DAY],
  );
  return r?.n ?? 0;
}

/** An active card on the template with this address: the one the duplicate rule mails instead of making another. */
export async function activeCardFor(
  db: D1Database,
  link: Pick<PublicLink, 'orgId' | 'mode' | 'templateId'>,
  email: string,
): Promise<string | null> {
  const r = await first<{ id: string }>(
    db,
    `SELECT p.id FROM passes p
      WHERE p.org_id = ? AND p.mode = ? AND p.template_id = ? AND p.holder_email = ?
        AND p.status = 'active' AND p.removed_at IS NULL AND p.deleted_at IS NULL
        AND p.test_data_quarantined = 0
      ORDER BY p.created_at LIMIT 1`,
    [link.orgId, link.mode, link.templateId, email],
  );
  return r?.id ?? null;
}

/** Whether a link made this card: its mail carries the "You asked for this card" line. */
export async function isJoinCard(db: D1Database, passId: string): Promise<boolean> {
  return (await first(db, 'SELECT 1 AS one FROM join_issues WHERE pass_id = ?', [passId])) !== null;
}
