/** Rows to rendered rows (DM 1.6, 5.1). Pure. Missing values hide the row; caps cut by grapheme. */
import type { ScanChip, ScanDisplayRow } from '../../../shared/contracts/scan-display.ts';
import { SCAN_DISPLAY_COPY, scanLine } from '../../../shared/copy/scan.ts';
import type { Json } from '../../types.ts';
import { testCond } from './condition.ts';
import { columnsUnits, DENSITY, oneLineCap } from './density.ts';
import { applyFilter, graphemeLength, moneyText, sanitized, toNumber, truncate } from './format.ts';
import type { ScanChipDoc, ScanCond, ScanRowDoc, ScanText } from './schema.ts';
import { type EvalCtx, evalExpr, evalText, parseParts, splitPath } from './text.ts';

export interface RowCtx extends EvalCtx {
  /** The document's currency, when it names one. */
  docCurrency: string | null;
}

const COPY = SCAN_DISPLAY_COPY;
const DASH = '—';
const MINUS = '−';

export const shown = (el: { when?: ScanCond | undefined }, rc: EvalCtx): boolean =>
  !el.when || testCond(el.when, rc);

const text = (value: ScanText | null | undefined, rc: EvalCtx, cap: number, breaks = false) =>
  sanitized(evalText(value, rc), cap, breaks);
const orNull = (value: string) => (value === '' ? null : value);

export function renderChips(items: ScanChipDoc[], rc: EvalCtx): ScanChip[] {
  const out: ScanChip[] = [];
  for (const chip of items) {
    if (!shown(chip, rc)) continue;
    const label = text(chip.text, rc, 16);
    if (label) out.push({ id: chip.id, text: label, tone: chip.tone, icon: chip.icon ?? null });
  }
  return out;
}

const loneInput = (source: string): string | null => {
  const parts = parseParts(source).parts;
  const path = parts?.length === 1 && !parts[0]?.filter ? parts[0]?.path : undefined;
  const split = path ? splitPath(path) : null;
  return split?.root === 'inputs' ? (split.rest[0] ?? null) : null;
};

const record = (value: unknown): Record<string, Json> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : null;

/** The scan's before value, when this scan changed the row's input. */
function scanValue(rc: EvalCtx, input: string | null, key: 'before' | 'after'): number | null {
  const scan = record(rc.scope.scan);
  if (!scan || (scan.input !== undefined && scan.input !== input)) return null;
  return toNumber(scan[key]);
}

function progress(
  row: Extract<ScanRowDoc, { type: 'progress' }>,
  rc: RowCtx,
): ScanDisplayRow | null {
  const input = loneInput(row.value);
  const value = toNumber(evalExpr(row.value, rc));
  const taken = input ? record(record(rc.scope.goals)?.[input]) : null;
  const goalRaw =
    typeof row.goal === 'number'
      ? row.goal
      : typeof row.goal === 'string'
        ? toNumber(evalExpr(row.goal, rc))
        : toNumber(taken?.goal);
  if (value === null || goalRaw === null) return null;
  const goal = Math.min(1000, Math.max(1, Math.round(goalRaw)));
  const reward =
    text(row.reward, rc, 24) || (typeof taken?.reward === 'string' ? taken.reward : '');
  const earned = row.rewards !== undefined ? toNumber(evalExpr(row.rewards, rc)) : null;
  const rewards = Math.max(0, Math.floor(earned ?? value / goal));
  const style = row.style === 'bar' || goal > 10 ? 'bar' : 'stamps';
  const left = Math.max(0, Math.ceil(goal - value));
  const caption =
    rewards >= 1
      ? scanLine(rewards === 1 ? COPY.rewardsReady.one : COPY.rewardsReady.other, { n: rewards })
      : reward
        ? scanLine(COPY.moreFor, { n: left, reward })
        : `${value} of ${goal}`;
  return {
    type: 'progress',
    id: row.id,
    value,
    goal,
    before: scanValue(rc, input, 'before'),
    style,
    icon: row.icon ?? null,
    rewards,
    caption: truncate(caption, 48),
  };
}

function money(row: Extract<ScanRowDoc, { type: 'money' }>, rc: RowCtx): ScanDisplayRow | null {
  const amount = toNumber(evalExpr(row.amount, rc));
  if (amount === null) return null;
  const own = row.currency ? text(row.currency, rc, 3) : '';
  const code = /^[A-Z]{3}$/.test(own) ? own : rc.docCurrency;
  const input = loneInput(row.amount);
  const before = scanValue(rc, input, 'before');
  const after = scanValue(rc, input, 'after');
  return {
    type: 'money',
    id: row.id,
    label: orNull(text(row.label, rc, 20)),
    amount,
    currency: code,
    text: truncate(moneyText(amount, rc.locale, code), 16),
    before,
    change: before !== null && after !== null ? after - before : null,
    low: row.lowBelow !== undefined && amount < row.lowBelow,
    pending: (row.pending ?? []).slice(0, 6),
  };
}

const HISTORY_SHOW = {
  value: ['amount', 'when'],
  visits: ['when', 'where'],
  scans: ['when', 'action'],
} as const;

function signed(n: number, rc: RowCtx): string {
  return `${n < 0 ? MINUS : '+'}${moneyText(Math.abs(n), rc.locale, rc.docCurrency)}`;
}

function history(row: Extract<ScanRowDoc, { type: 'history' }>, rc: RowCtx): ScanDisplayRow | null {
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
        show.has('action') && typeof entry.label === 'string'
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

function columns(row: Extract<ScanRowDoc, { type: 'columns' }>, rc: RowCtx): ScanDisplayRow | null {
  const size = row.size ?? 'normal';
  const valueCap = size === 'big' ? 8 : 16;
  const cells = row.items.map((cell) => ({
    label: text(cell.label, rc, 12),
    value: text(cell.value, rc, valueCap),
  }));
  if (cells.every((cell) => cell.value === '')) return null;
  const items = cells.map((cell) => ({ label: cell.label, value: cell.value || DASH }));
  const cap = oneLineCap(size, items.length);
  return {
    type: 'columns',
    id: row.id,
    size,
    oneLine: items.every((cell) => graphemeLength(cell.value) <= cap),
    items,
  };
}

export function renderRow(row: ScanRowDoc, rc: RowCtx): ScanDisplayRow | null {
  if (!shown(row, rc)) return null;
  switch (row.type) {
    case 'heading': {
      const value = text(row.text, rc, 24);
      return value
        ? { type: 'heading', id: row.id, text: value, detail: orNull(text(row.detail, rc, 24)) }
        : null;
    }
    case 'field': {
      const label = text(row.label, rc, 20);
      let value = text(row.value, rc, 48);
      if (!value) {
        if (row.whenEmpty !== 'dash') return null;
        value = DASH;
      }
      return {
        type: 'field',
        id: row.id,
        label,
        value,
        icon: row.icon ?? null,
        strong: row.strong ?? false,
      };
    }
    case 'big': {
      const value = text(row.value, rc, 12);
      return value
        ? {
            type: 'big',
            id: row.id,
            label: orNull(text(row.label, rc, 20)),
            value,
            unit: orNull(text(row.unit, rc, 12)),
            tone: row.tone ?? null,
          }
        : null;
    }
    case 'columns':
      return columns(row, rc);
    case 'progress':
      return progress(row, rc);
    case 'money':
      return money(row, rc);
    case 'history':
      return history(row, rc);
    case 'image': {
      const url = record(rc.scope.assets)?.[row.source];
      if (typeof url !== 'string' || url === '') return null;
      const title = orNull(text(row.title, rc, 32));
      return {
        type: 'image',
        id: row.id,
        source: row.source,
        url,
        alt: row.source === 'strip' ? '' : (title ?? ''),
        title,
        detail: orNull(text(row.detail, rc, 40)),
      };
    }
    case 'chips': {
      const items = renderChips(row.items, rc).slice(0, 4);
      return items.length > 0 ? { type: 'chips', id: row.id, items } : null;
    }
    case 'list': {
      const items = row.items
        .filter((item) => shown(item, rc))
        .map((item) => ({
          id: item.id,
          icon: item.icon,
          text: text(item.text, rc, 32),
          detail: orNull(text(item.detail, rc, 24)),
        }))
        .filter((item) => item.text !== '')
        .slice(0, 4);
      if (items.length === 0) return null;
      const pair = row.pair ?? false;
      const oneLine =
        pair &&
        items.every(
          (i) =>
            graphemeLength(i.text) <= DENSITY.pair.text &&
            graphemeLength(i.detail ?? '') <= DENSITY.pair.detail,
        );
      return { type: 'list', id: row.id, pair, oneLine, items };
    }
    case 'note': {
      const value = text(row.text, rc, 140, true);
      return value
        ? {
            type: 'note',
            id: row.id,
            text: value,
            tone: row.tone ?? 'neutral',
            icon: row.icon ?? null,
          }
        : null;
    }
    case 'divider':
      return { type: 'divider', id: row.id };
  }
}

/** Units of a rendered row: what is emitted, with `oneLine` credited (DM 1.6 render time). */
export function renderedUnits(row: ScanDisplayRow): number {
  switch (row.type) {
    case 'heading':
      return 0.5;
    case 'field':
    case 'chips':
    case 'note':
      return 1;
    case 'big':
    case 'money':
    case 'image':
      return 2;
    case 'columns':
      return columnsUnits(row.size, row.items.length, row.oneLine);
    case 'progress':
      return row.style === 'stamps' ? 3 : 2;
    case 'history':
      return 0.5 + 0.5 * row.items.length;
    case 'list':
      return 0.5 * (row.pair && row.oneLine ? Math.ceil(row.items.length / 2) : row.items.length);
    case 'divider':
      return 0;
  }
}
