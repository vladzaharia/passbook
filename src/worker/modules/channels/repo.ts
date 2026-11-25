import { holderMayPrint } from '../../../passkit/template/paper.ts';
import {
  CHANNELS,
  type Channel,
  type PassChannelState,
  type TemplateChannelState,
} from '../../../shared/contracts/channels.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { all, chunk, first, placeholders, run } from '../../platform/db.ts';
import { effectiveReleaseIdSql } from '../templates/repo-release-heads.ts';

export interface TemplateRef {
  id: string;
  /** The org the policy is for. */
  orgId: string;
  activeVersion: string | null;
}

/**
 * A template and its owner: null for a baked or shared platform template, which any org may set a
 * policy for. Staged uploads, blueprints and inactive platform templates are not found.
 */
export async function templateOwner(
  db: D1Database,
  id: string,
): Promise<{ id: string; ownerOrgId: string | null; activeVersion: string | null } | null> {
  const r = await first<{ id: string; org_id: string | null; active_version: string | null }>(
    db,
    `SELECT id, org_id, active_version FROM templates WHERE id = ?
       AND (org_id IS NOT NULL
         OR ((origin = 'baked' OR shared = 1) AND blueprint = 0 AND status = 'active'))`,
    [id],
  );
  return r ? { id: r.id, ownerOrgId: r.org_id, activeVersion: r.active_version } : null;
}

const isChannel = (v: unknown): v is Channel => (CHANNELS as readonly unknown[]).includes(v);

export type Policy = Partial<Record<Channel, TemplateChannelState>>;

export interface PolicyRow {
  channels: Policy;
  revision: number;
}

export async function getPolicy(
  db: D1Database,
  orgId: string,
  mode: Mode,
  templateId: string,
): Promise<PolicyRow | null> {
  const r = await first<{ channels: string; revision: number }>(
    db,
    `SELECT channels, revision FROM template_channel_policies
     WHERE org_id = ? AND mode = ? AND template_id = ?`,
    [orgId, mode, templateId],
  );
  return r ? { channels: parsePolicy(r.channels), revision: r.revision } : null;
}

/** A stored policy; unknown channels and states are dropped. */
export function parsePolicy(text: string): Policy {
  const channels: Policy = {};
  for (const [k, v] of Object.entries(JSON.parse(text) as Record<string, unknown>))
    if (isChannel(k) && (v === 'on' || v === 'off' || v === 'never')) channels[k] = v;
  return channels;
}

/** The version the org's release of this template serves in this mode (Apple head), if any. */
export async function releasedVersion(
  db: D1Database,
  templateId: string,
  orgId: string,
  mode: Mode,
): Promise<string | null> {
  const select = effectiveReleaseIdSql({
    templateIdSql: 's.template_id',
    orgIdSql: 's.org_id',
    modeSql: 's.mode',
    providerSql: 's.provider',
  });
  const r = await first<{ version: string }>(
    db,
    `SELECT r.version FROM template_releases r
     WHERE r.id = (SELECT (${select}) FROM
       (SELECT ? AS template_id, ? AS org_id, ? AS mode, ? AS provider) s)`,
    [templateId, orgId, mode, 'apple'],
  );
  return r?.version ?? null;
}

export interface PassChannelRows {
  overrides: Partial<Record<Channel, PassChannelState>>;
  retired: Partial<Record<Channel, number>>;
  retiredCause: Partial<Record<Channel, 'pass' | 'template'>>;
  /** When each channel row last changed (a pending Apple bump compares it with the pass's modifiedAt). */
  setAt: Partial<Record<Channel, number>>;
  copies: Channel[];
}

export const emptyRows = (): PassChannelRows => ({
  overrides: {},
  retired: {},
  retiredCause: {},
  setAt: {},
  copies: [],
});

/** Channel rows and copy evidence for many passes, two queries per 90 ids. */
export async function getPassChannelRowsMany(
  db: D1Database,
  passIds: readonly string[],
): Promise<Map<string, PassChannelRows>> {
  const out = new Map<string, PassChannelRows>();
  for (const ids of chunk([...new Set(passIds)])) {
    const marks = placeholders(ids.length);
    const [rows, copies] = await Promise.all([
      all<{
        pass_id: string;
        channel: string;
        override: PassChannelState | null;
        retired_at: number | null;
        retired_cause: 'pass' | 'template' | null;
        set_at: number;
      }>(
        db,
        `SELECT pass_id, channel, override, retired_at, retired_cause, set_at FROM pass_channels
         WHERE pass_id IN (${marks})`,
        ids,
      ),
      all<{ pass_id: string; channel: string }>(
        db,
        `SELECT pass_id, channel FROM pass_channel_copies WHERE pass_id IN (${marks})`,
        ids,
      ),
    ]);
    const of = (id: string) => {
      let r = out.get(id);
      if (!r) {
        r = emptyRows();
        out.set(id, r);
      }
      return r;
    };
    for (const r of rows) {
      if (!isChannel(r.channel)) continue;
      const o = of(r.pass_id);
      if (r.override) o.overrides[r.channel] = r.override;
      if (r.retired_at !== null) o.retired[r.channel] = r.retired_at;
      o.setAt[r.channel] = r.set_at;
      if (r.retired_cause) o.retiredCause[r.channel] = r.retired_cause;
    }
    for (const r of copies) if (isChannel(r.channel)) of(r.pass_id).copies.push(r.channel);
  }
  return out;
}

export interface Capability {
  google: boolean;
  samsung: boolean;
  /** The manifest's paper block allows a holder print (absent: it does). */
  paperHolder: boolean;
  /** The manifest's `channels` defaults; a channel it does not name is absent. */
  defaults: Partial<Record<Channel, 'on' | 'off'>>;
}

/** What a template version can serve: a wallets block per provider (type absent or not off) per provider. */
export async function capabilityOf(
  db: D1Database,
  templateId: string,
  version: string | null,
): Promise<Capability> {
  const r = version
    ? await first<{ g: string | null; s: string | null; m: string | null; d: string | null }>(
        db,
        `SELECT CASE WHEN json_type(manifest, '$.wallets.google') = 'object'
             THEN COALESCE(json_extract(manifest, '$.wallets.google.type'), 'on') END AS g,
           CASE WHEN json_type(manifest, '$.wallets.samsung') = 'object'
             THEN COALESCE(json_extract(manifest, '$.wallets.samsung.type'), 'on') END AS s,
           manifest AS m,
           CASE WHEN json_type(manifest, '$.channels') = 'object'
             THEN json_extract(manifest, '$.channels') END AS d
         FROM template_versions WHERE template_id = ? AND version = ?`,
        [templateId, version],
      )
    : null;
  return {
    google: !!r?.g && r.g !== 'off',
    samsung: !!r?.s && r.s !== 'off',
    paperHolder: holderMayPrint(r?.m ? (JSON.parse(r.m) as Record<string, unknown>) : null),
    defaults: parseDefaults(r?.d),
  };
}

/** A template's manifest defaults as the org sees them: its released version, else the active one. */
export async function templateDefaultsOf(
  db: D1Database,
  templateId: string,
  orgId: string,
  mode: Mode,
): Promise<Capability['defaults']> {
  const version =
    (await releasedVersion(db, templateId, orgId, mode)) ??
    (await templateOwner(db, templateId))?.activeVersion ??
    null;
  return (await capabilityOf(db, templateId, version)).defaults;
}

/** `json_extract` of an object is valid JSON text, so the parse cannot fail. */
function parseDefaults(raw: string | null | undefined): Capability['defaults'] {
  const out: Capability['defaults'] = {};
  if (!raw) return out;
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  for (const c of CHANNELS) if (parsed[c] === 'on' || parsed[c] === 'off') out[c] = parsed[c];
  return out;
}

export interface OverrideGroup {
  override: PassChannelState | null;
  passes: number;
}

/** Passes of a template by their override in one channel. */
export async function overrideGroups(
  db: D1Database,
  orgId: string,
  mode: Mode,
  templateId: string,
  channel: Channel,
): Promise<OverrideGroup[]> {
  const rows = await all<{ override: PassChannelState | null; n: number }>(
    db,
    `SELECT pc.override AS override, COUNT(*) AS n FROM passes p
     LEFT JOIN pass_channels pc ON pc.pass_id = p.id AND pc.channel = ?
     WHERE p.org_id = ? AND p.mode = ? AND p.template_id = ? AND p.deleted_at IS NULL
     GROUP BY pc.override`,
    [channel, orgId, mode, templateId],
  );
  return rows.map((r) => ({ override: r.override, passes: r.n }));
}

/** Copy evidence: insert-once, so a later delivery never moves the first one. */
export async function insertCopy(
  db: D1Database,
  pass: { id: string; orgId: string; mode: Mode },
  channel: Channel,
  at: number,
): Promise<void> {
  await run(
    db,
    `INSERT OR IGNORE INTO pass_channel_copies (pass_id, org_id, mode, channel, copy_at)
     VALUES (?, ?, ?, ?, ?)`,
    [pass.id, pass.orgId, pass.mode, channel, at],
  );
}

/** Whether a New code was issued for the pass at or after `since`. */
export async function rotatedSince(
  db: D1Database,
  orgId: string,
  passId: string,
  since: number,
): Promise<boolean> {
  const r = await first(
    db,
    'SELECT 1 AS hit FROM scan_code_rotations WHERE org_id = ? AND pass_id = ? AND rotated_at >= ? LIMIT 1',
    [orgId, passId, since],
  );
  return r !== null;
}

/** Whether the pass has any print, active or past. */
export async function hasPrint(db: D1Database, orgId: string, passId: string): Promise<boolean> {
  return (
    (await first(db, 'SELECT 1 AS hit FROM pass_prints WHERE org_id = ? AND pass_id = ? LIMIT 1', [
      orgId,
      passId,
    ])) !== null
  );
}
