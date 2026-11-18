import { type Check, rawCheck } from '../../platform/authority-checks.ts';
import { bump } from '../../platform/counters.ts';
import { first } from '../../platform/db.ts';
import { RateLimitedError } from '../../platform/errors.ts';

/** Fixed windows per device. Unknown tags are counted by inspect; binds and previews by the bind route. */
const CAPS = {
  unknown: { windowMs: 600_000, cap: 30 },
  bind: { windowMs: 3_600_000, cap: 60 },
  preview: { windowMs: 3_600_000, cap: 120 },
} as const;

export type TagCap = keyof typeof CAPS;

/** Counts one try for this device and refuses it past the cap. */
export async function bumpTagCap(
  db: D1Database,
  kind: TagCap,
  scannerId: string,
  now: number,
): Promise<void> {
  const { windowMs, cap } = CAPS[kind];
  const start = now - (now % windowMs);
  const used = await bump(db, `scan:tag:${kind}:${scannerId}`, start);
  if (used > cap)
    throw new RateLimitedError(
      Math.max(1, Math.ceil((start + windowMs - now) / 1000)),
      'Too many tries. Wait and try again.',
    );
}

export interface CardFacts {
  templateName: string;
  holderName: string | null;
  /** The pass's owner exists and is active, so a user binding is possible. */
  ownerActive: boolean;
}

/** What the card summary names: the template and the owner account's name. */
export async function cardFacts(
  db: D1Database,
  templateId: string,
  ownerUserId: string | null,
): Promise<CardFacts> {
  const row = await first<{ name: string; holder: string | null; status: string | null }>(
    db,
    `SELECT t.name, u.name AS holder, u.status FROM templates t LEFT JOIN users u ON u.id = ? WHERE t.id = ?`,
    [ownerUserId, templateId],
  );
  return {
    templateName: row?.name ?? '',
    holderName: row?.holder ?? null,
    ownerActive: row?.status === 'active',
  };
}

/** A user binding needs an active account at commit. */
export const ownerActiveCheck = (userId: string): Check =>
  rawCheck('lineage', "EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'active')", [userId]);

export interface BoundRow {
  id: string;
  tagId: string;
  scope: 'pass' | 'user';
  scannerId: string | null;
  source: 'scanner' | 'remote' | 'admin';
  boundAt: number;
  endedAt: number | null;
  orgId: string;
  mode: 'live' | 'test';
}

/** A binding with its tenant, for undo and for a retried bind. */
export async function boundRow(db: D1Database, id: string): Promise<BoundRow | null> {
  const r = await first<{
    id: string;
    tag_id: string;
    scope: 'pass' | 'user';
    scanner_id: string | null;
    source: 'scanner' | 'remote' | 'admin';
    bound_at: number;
    ended_at: number | null;
    org_id: string;
    mode: 'live' | 'test';
  }>(
    db,
    `SELECT b.id, b.tag_id, b.scope, b.scanner_id, b.source, b.bound_at, b.ended_at, t.org_id, t.mode
     FROM tag_bindings b JOIN nfc_tags t ON t.id = b.tag_id WHERE b.id = ?`,
    [id],
  );
  return r
    ? {
        id: r.id,
        tagId: r.tag_id,
        scope: r.scope,
        scannerId: r.scanner_id,
        source: r.source,
        boundAt: r.bound_at,
        endedAt: r.ended_at,
        orgId: r.org_id,
        mode: r.mode,
      }
    : null;
}
