import { type Check, rawCheck } from '../../platform/authority-checks.ts';
import { authorityPredicate } from '../../platform/authority-read.ts';
import { bump } from '../../platform/counters.ts';
import { first } from '../../platform/db.ts';
import { RateLimitedError } from '../../platform/errors.ts';
import { scanPrincipal } from './authority-checks.ts';
import type { ScanActor } from './guard.ts';

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
  /** The lost report this bind cleared. */
  clearedLostAt: number | null;
  clearedLostBy: string | null;
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
    cleared_lost_at: number | null;
    cleared_lost_by: string | null;
  }>(
    db,
    `SELECT b.id, b.tag_id, b.scope, b.scanner_id, b.source, b.bound_at, b.ended_at, t.org_id, t.mode,
       b.cleared_lost_at, b.cleared_lost_by
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
        clearedLostAt: r.cleared_lost_at,
        clearedLostBy: r.cleared_lost_by,
      }
    : null;
}

/** A PIN guess is spent only while the actor is live (as the undo's guard, without a target). */
export function liveActorGuard(actor: ScanActor, now: number) {
  const read = authorityPredicate(scanPrincipal(actor), { scope: 'org_mode', now });
  return { sql: `EXISTS (WITH ${read.ctes} SELECT 1 FROM actor_ok)`, params: read.params };
}

export interface ReplayRow {
  bindingId: string;
  requestHash: string | null;
  scope: 'pass' | 'user';
  boundAt: number;
  endedAt: number | null;
  passId: string;
  title: string | null;
  subtitle: string | null;
  templateName: string;
  holderName: string | null;
  ownerActive: boolean;
  hint: string;
  lostAt: number | null;
}

/** The binding this device made with this key, and what the answer names. */
export async function replayRow(
  db: D1Database,
  scannerId: string,
  key: string,
): Promise<ReplayRow | null> {
  const r = await first<{
    id: string;
    request_hash: string | null;
    scope: 'pass' | 'user';
    bound_at: number;
    ended_at: number | null;
    pass_id: string;
    display_title: string | null;
    display_subtitle: string | null;
    template_name: string | null;
    holder: string | null;
    owner_status: string | null;
    hint: string;
    lost_at: number | null;
  }>(
    db,
    `SELECT b.id, b.request_hash, b.scope, b.bound_at, b.ended_at, b.pass_id, p.display_title, p.display_subtitle,
       tp.name AS template_name, u.name AS holder, u.status AS owner_status, t.hint, t.lost_at
     FROM tag_bindings b JOIN nfc_tags t ON t.id = b.tag_id JOIN passes p ON p.id = b.pass_id
     LEFT JOIN templates tp ON tp.id = p.template_id LEFT JOIN users u ON u.id = p.owner_user_id
     WHERE b.scanner_id = ? AND b.idempotency_key = ?`,
    [scannerId, key],
  );
  return r
    ? {
        bindingId: r.id,
        requestHash: r.request_hash,
        scope: r.scope,
        boundAt: r.bound_at,
        endedAt: r.ended_at,
        passId: r.pass_id,
        title: r.display_title,
        subtitle: r.display_subtitle,
        templateName: r.template_name ?? '',
        holderName: r.holder,
        ownerActive: r.owner_status === 'active',
        hint: r.hint,
        lostAt: r.lost_at,
      }
    : null;
}

/** The template of a pass, for what a scanner may be told about it. */
export async function passTemplate(db: D1Database, passId: string): Promise<string | null> {
  const r = await first<{ template_id: string }>(
    db,
    'SELECT template_id FROM passes WHERE id = ?',
    [passId],
  );
  return r?.template_id ?? null;
}
