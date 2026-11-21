import { CHANNELS, type Channel } from '../../../shared/contracts/channels.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { all, first, placeholders } from '../../platform/db.ts';

const empty = () => Object.fromEntries(CHANNELS.map((c) => [c, 0])) as Record<Channel, number>;

/** Passes of a template (in a mode) with their own choice, by channel. */
export async function overrideCounts(
  db: D1Database,
  orgId: string,
  mode: Mode,
  templateId: string,
): Promise<Record<Channel, number>> {
  const rows = await all<{ channel: Channel; n: number }>(
    db,
    `SELECT pc.channel AS channel, COUNT(*) AS n FROM pass_channels pc
     JOIN passes p ON p.id = pc.pass_id
     WHERE pc.org_id = ? AND pc.mode = ? AND pc.template_id = ? AND pc.override IS NOT NULL
       AND p.deleted_at IS NULL
     GROUP BY pc.channel`,
    [orgId, mode, templateId],
  );
  const out = empty();
  for (const r of rows) out[r.channel] = r.n;
  return out;
}

/** How many distinct passes carry an override in `channels`. */
export async function overridePassCount(
  db: D1Database,
  orgId: string,
  mode: Mode,
  templateId: string,
  channels: readonly Channel[],
): Promise<number> {
  const r = await first<{ n: number }>(
    db,
    `SELECT COUNT(DISTINCT pc.pass_id) AS n FROM pass_channels pc
     JOIN passes p ON p.id = pc.pass_id
     WHERE pc.org_id = ? AND pc.mode = ? AND pc.template_id = ? AND pc.override IS NOT NULL
       AND p.deleted_at IS NULL AND pc.channel IN (${placeholders(channels.length)})`,
    [orgId, mode, templateId, ...channels],
  );
  return r?.n ?? 0;
}

/** The next page of passes with an override in `channels`, with the channels to clear on each. */
export async function overridePage(
  db: D1Database,
  orgId: string,
  mode: Mode,
  templateId: string,
  channels: readonly Channel[],
  limit: number,
): Promise<{ passId: string; channels: Channel[] }[]> {
  const ids = await all<{ id: string }>(
    db,
    `SELECT DISTINCT pc.pass_id AS id FROM pass_channels pc
     JOIN passes p ON p.id = pc.pass_id
     WHERE pc.org_id = ? AND pc.mode = ? AND pc.template_id = ? AND pc.override IS NOT NULL
       AND p.deleted_at IS NULL AND pc.channel IN (${placeholders(channels.length)})
     ORDER BY pc.pass_id LIMIT ?`,
    [orgId, mode, templateId, ...channels, limit],
  );
  if (ids.length === 0) return [];
  const rows = await all<{ pass_id: string; channel: Channel }>(
    db,
    `SELECT pass_id, channel FROM pass_channels
     WHERE pass_id IN (${placeholders(ids.length)}) AND override IS NOT NULL
       AND channel IN (${placeholders(channels.length)})`,
    [...ids.map((r) => r.id), ...channels],
  );
  const by = new Map<string, Channel[]>();
  for (const r of rows) by.set(r.pass_id, [...(by.get(r.pass_id) ?? []), r.channel]);
  return ids.map((r) => ({ passId: r.id, channels: by.get(r.id) ?? [] }));
}
