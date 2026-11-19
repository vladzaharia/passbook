import { CHANNELS, type Channel, type ChannelSource } from '../../../shared/contracts/channels.ts';
import { all, chunk, placeholders } from '../../platform/db.ts';
import type { ApplyRun } from './repo-runs.ts';

export const PAGE_SIZE = 100;

/** One effective flip, as the mark stores it and the journal receives it (the CH1 shape plus the run). */
export type ApplyEvent = {
  channel: Channel;
  from: 'on' | 'off';
  to: 'on' | 'off';
  source: ChannelSource;
  runId: string;
};

export interface PagePass {
  id: string;
  orgId: string;
  mode: ApplyRun['mode'];
  templateId: string;
  templateVersion: string;
}

/** The run's passes after the cursor, by id: live passes only (a removed pass still carries its rows). */
export async function passPage(
  db: D1Database,
  run: ApplyRun,
  limit = PAGE_SIZE,
): Promise<PagePass[]> {
  const rows = await all<{
    id: string;
    org_id: string;
    mode: ApplyRun['mode'];
    template_id: string;
    template_version: string;
  }>(
    db,
    `SELECT id, org_id, mode, template_id, template_version FROM passes
     WHERE org_id = ? AND mode = ? AND template_id = ? AND deleted_at IS NULL AND id > ?
     ORDER BY id LIMIT ?`,
    [run.orgId, run.mode, run.templateId, run.cursor ?? '', limit],
  );
  return rows.map((r) => ({
    id: r.id,
    orgId: r.org_id,
    mode: r.mode,
    templateId: r.template_id,
    templateVersion: r.template_version,
  }));
}

/** The pass ids of this run that already have a mark, with the events the mark holds. */
export async function marksOf(
  db: D1Database,
  runId: string,
  passIds: readonly string[],
): Promise<Map<string, ApplyEvent[]>> {
  const out = new Map<string, ApplyEvent[]>();
  for (const ids of chunk([...passIds])) {
    const rows = await all<{ pass_id: string; events: string }>(
      db,
      `SELECT pass_id, events FROM channel_apply_marks
       WHERE run_id = ? AND pass_id IN (${placeholders(ids.length)})`,
      [runId, ...ids],
    );
    for (const r of rows) out.set(r.pass_id, JSON.parse(r.events));
  }
  return out;
}

/** Marks whose events are not in the journal yet. */
export async function unjournaled(
  db: D1Database,
  runId: string,
  limit = PAGE_SIZE,
): Promise<{ passId: string; events: ApplyEvent[] }[]> {
  const rows = await all<{ pass_id: string; events: string }>(
    db,
    'SELECT pass_id, events FROM channel_apply_marks WHERE run_id = ? AND journaled_at IS NULL LIMIT ?',
    [runId, limit],
  );
  return rows.map((r) => ({ passId: r.pass_id, events: JSON.parse(r.events) }));
}

/** The revision of every channel row of the passes, to assert against on write. */
export async function channelRevisions(
  db: D1Database,
  passIds: readonly string[],
): Promise<Map<string, Partial<Record<Channel, number>>>> {
  const out = new Map<string, Partial<Record<Channel, number>>>();
  for (const ids of chunk([...passIds])) {
    const rows = await all<{ pass_id: string; channel: string; revision: number }>(
      db,
      `SELECT pass_id, channel, revision FROM pass_channels WHERE pass_id IN (${placeholders(ids.length)})`,
      ids,
    );
    for (const r of rows) {
      const channel = CHANNELS.find((c) => c === r.channel);
      if (!channel) continue;
      const of = out.get(r.pass_id) ?? {};
      of[channel] = r.revision;
      out.set(r.pass_id, of);
    }
  }
  return out;
}
