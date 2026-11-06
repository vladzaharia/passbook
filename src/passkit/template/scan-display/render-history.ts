/** The `history` row (DM 1.10): the server's lists, formatted, plus one "Changed elsewhere" row. */
import type { ScanDisplayRow } from '../../../shared/contracts/scan-display.ts';
import { DENSITY } from './density.ts';
import { applyFilter, moneyText, sanitized, toNumber } from './format.ts';
import { COPY, MINUS, orNull, type RowCtx, record } from './render-kit.ts';
import type { ScanRowDoc } from './schema.ts';

const HISTORY_SHOW = {
  value: ['amount', 'when'],
  visits: ['when', 'where'],
  scans: ['when', 'action'],
} as const;

function signed(n: number, rc: RowCtx): string {
  return `${n < 0 ? MINUS : '+'}${moneyText(Math.abs(n), rc.locale, rc.docCurrency)}`;
}

export function history(
  row: Extract<ScanRowDoc, { type: 'history' }>,
  rc: RowCtx,
): ScanDisplayRow | null {
  const lists = record(record(rc.scope.history)?.list);
  const found =
    row.source === 'value' ? record(lists?.value)?.[row.input ?? ''] : lists?.[row.source];
  const list = (Array.isArray(found) ? found : []).map(record).filter((x) => x !== null);
  const show = new Set<string>(row.show ?? HISTORY_SHOW[row.source]);
  const items = list.slice(0, row.limit ?? DENSITY.historyDefaultLimit).map((entry) => {
    const at = toNumber(entry.at);
    const amount = toNumber(entry.amount);
    return {
      at: at === null ? null : Math.round(at),
      when: show.has('when') && at !== null ? orNull(applyFilter('ago', at, rc)) : null,
      amount: show.has('amount') && amount !== null ? signed(amount, rc) : null,
      delta: amount,
      where:
        show.has('where') && typeof entry.where === 'string'
          ? orNull(sanitized(entry.where, 24))
          : null,
      label:
        (show.has('action') || row.source === 'value') && typeof entry.label === 'string'
          ? orNull(sanitized(entry.label, 24))
          : null,
      elsewhere: false,
    };
  });
  const current = toNumber(record(rc.scope.inputs)?.[row.input ?? '']);
  const newest = toNumber(list[0]?.after);
  if (row.source === 'value' && current !== null && newest !== null && current !== newest) {
    const delta = current - newest;
    items.unshift({
      at: null,
      when: null,
      amount: show.has('amount') ? signed(delta, rc) : null,
      delta,
      where: null,
      label: COPY.changedElsewhere,
      elsewhere: true,
    });
  }
  const empty = items.length === 0 && row.source === 'visits' ? COPY.noVisits : null;
  if (items.length === 0 && !empty) return null;
  return { type: 'history', id: row.id, items: items.slice(0, 6), empty };
}
