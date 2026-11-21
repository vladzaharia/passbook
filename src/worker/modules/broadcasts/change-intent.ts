import type { Json } from '../../../shared/contracts/common.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { atValues } from './change-ops.ts';
import { type BroadcastRow, clearIntent, insertItems, pendingIntents } from './repo.ts';
import { hasVersionFrom } from './repo-items.ts';

/** What a change was about to do to one pass: its touched values before and after, and the pass version it read. */
export interface Intent {
  action?: 'void' | 'design';
  from: Record<string, Json>;
  to: Record<string, Json>;
  version: number;
}

const SETTLE = 25;

/**
 * Settles passes a step died on: an intent is written before a pass is changed and cleared with its
 * item, so one left over is a change that may or may not have landed. A pass found at the values the
 * change set (or voided, or on the new design) is recorded with the earlier values it had, once; a
 * pass that never changed drops the intent and is read again like any other. Nothing is applied twice.
 */
export async function settlePending(ctx: ServiceContext, row: BroadcastRow): Promise<void> {
  const db = ctx.env.DB;
  for (;;) {
    const rows = await pendingIntents(db, row.id, SETTLE);
    for (const r of rows) {
      const intent = JSON.parse(r.intent) as Intent;
      const pass = await getPass(db, r.pass_id, row.org_id);
      const landed =
        pass !== null &&
        pass.mode === row.mode &&
        (intent.action === 'void'
          ? pass.status === 'voided' && pass.version > intent.version
          : intent.action === 'design'
            ? pass.templateVersion === intent.to.templateVersion
            : atValues(pass.personalization, intent.to) ||
              (pass.version > intent.version &&
                (await hasVersionFrom(db, r.pass_id, 'schedule', row.started_at ?? 0))));
      if (landed && pass) {
        const { version: _read, ...before } = intent;
        await insertItems(db, row.id, [
          {
            passId: r.pass_id,
            outcome: 'updated',
            silent: false,
            before: JSON.stringify(before),
            version: pass.version,
          },
        ]);
      } else await clearIntent(db, row.id, r.pass_id);
    }
    if (rows.length < SETTLE) return;
  }
}
