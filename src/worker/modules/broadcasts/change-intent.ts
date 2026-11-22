import type { Json } from '../../../shared/contracts/common.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { atValues } from './change-ops.ts';
import { type BroadcastRow, clearIntent, insertItems, pendingIntents } from './repo.ts';
import { stampedWrite, writeRefOf } from './repo-items.ts';

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
      // Only this run's own write counts: the version row it stamped with its id. Someone else's void or
      // edit is not ours, whatever values it left, and a racing edit between the read and the write is
      // told apart because `before` is read from the stamped version and the one before it.
      const write = await stampedWrite(db, r.pass_id, row.id, intent.version);
      // An input no field renders is stored with no version row; the run's id on the pass shows it landed.
      // Any later publish clears the id, and the pass is then read again like one that never changed.
      const stored =
        !write && pass !== null && pass.version > intent.version
          ? (await writeRefOf(db, r.pass_id)) === row.id
          : false;
      const landed =
        pass !== null &&
        pass.mode === row.mode &&
        (write !== null ||
          stored ||
          (intent.action === 'design'
            ? pass.templateVersion === intent.to.templateVersion
            : !intent.action &&
              pass.version === intent.version &&
              atValues(pass.personalization, intent.to)));
      if (landed && pass) {
        const { version: _read, ...before } = intent;
        if (write && !intent.action) {
          const now = JSON.parse(write.personalization) as Record<string, Json>;
          const earlier = JSON.parse(write.prev ?? '{}') as Record<string, Json>;
          for (const k of Object.keys(intent.to)) {
            before.from[k] = earlier[k] ?? null;
            before.to[k] = now[k] ?? null;
          }
        }
        await insertItems(db, row.id, [
          {
            passId: r.pass_id,
            outcome: 'updated',
            silent: false,
            before: JSON.stringify(before),
            version: write?.version ?? pass.version,
          },
        ]);
      } else await clearIntent(db, row.id, r.pass_id);
    }
    if (rows.length < SETTLE) return;
  }
}
