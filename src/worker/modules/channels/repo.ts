import {
  CHANNELS,
  type Channel,
  type PassChannelState,
  type TemplateChannelState,
} from '../../../shared/contracts/channels.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { all, first } from '../../platform/db.ts';

export interface TemplateRef {
  id: string;
  /** The org the policy is for. */
  orgId: string;
  activeVersion: string | null;
}

/** A template and its owner: null for a shared (baked) template, which any org may set a policy for. */
export async function templateOwner(
  db: D1Database,
  id: string,
): Promise<{ id: string; ownerOrgId: string | null; activeVersion: string | null } | null> {
  const r = await first<{ id: string; org_id: string | null; active_version: string | null }>(
    db,
    'SELECT id, org_id, active_version FROM templates WHERE id = ?',
    [id],
  );
  return r ? { id: r.id, ownerOrgId: r.org_id, activeVersion: r.active_version } : null;
}

const isChannel = (v: unknown): v is Channel => (CHANNELS as readonly unknown[]).includes(v);

export type Policy = Partial<Record<Channel, TemplateChannelState>>;

export async function getPolicy(
  db: D1Database,
  orgId: string,
  mode: Mode,
  templateId: string,
): Promise<Policy | null> {
  const r = await first<{ channels: string }>(
    db,
    'SELECT channels FROM template_channel_policies WHERE org_id = ? AND mode = ? AND template_id = ?',
    [orgId, mode, templateId],
  );
  if (!r) return null;
  const out: Policy = {};
  for (const [k, v] of Object.entries(JSON.parse(r.channels) as Record<string, unknown>))
    if (isChannel(k) && (v === 'on' || v === 'off' || v === 'never')) out[k] = v;
  return out;
}

export interface PassChannelRows {
  overrides: Partial<Record<Channel, PassChannelState>>;
  retired: Partial<Record<Channel, number>>;
  copies: Channel[];
}

export async function getPassChannelRows(db: D1Database, passId: string): Promise<PassChannelRows> {
  const [rows, copies] = await Promise.all([
    all<{ channel: string; override: PassChannelState | null; retired_at: number | null }>(
      db,
      'SELECT channel, override, retired_at FROM pass_channels WHERE pass_id = ?',
      [passId],
    ),
    all<{ channel: string }>(db, 'SELECT channel FROM pass_channel_copies WHERE pass_id = ?', [
      passId,
    ]),
  ]);
  const out: PassChannelRows = { overrides: {}, retired: {}, copies: [] };
  for (const r of rows) {
    if (!isChannel(r.channel)) continue;
    if (r.override) out.overrides[r.channel] = r.override;
    if (r.retired_at !== null) out.retired[r.channel] = r.retired_at;
  }
  for (const r of copies) if (isChannel(r.channel)) out.copies.push(r.channel);
  return out;
}

export interface Capability {
  google: boolean;
  samsung: boolean;
  scanTags: boolean;
}

/** What a template version can serve: a wallets block per provider (type not off) and scan.tags. */
export async function capabilityOf(
  db: D1Database,
  templateId: string,
  version: string | null,
): Promise<Capability> {
  const r = version
    ? await first<{ g: string | null; s: string | null; t: string | null }>(
        db,
        `SELECT json_extract(manifest, '$.wallets.google.type') AS g,
           json_extract(manifest, '$.wallets.samsung.type') AS s,
           json_type(manifest, '$.scan.tags') AS t
         FROM template_versions WHERE template_id = ? AND version = ?`,
        [templateId, version],
      )
    : null;
  return {
    google: !!r?.g && r.g !== 'off',
    samsung: !!r?.s && r.s !== 'off',
    scanTags: r?.t === 'object',
  };
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
