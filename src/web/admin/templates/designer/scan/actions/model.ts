import type {
  ScanAction,
  ScanActionKind,
  ScanManifest,
  ScanRepeat,
  ScanRole,
} from '@/passkit/types.ts';
import { DEFAULT_SCAN_ACTION, type ResolvedScanAction, scanOf } from '@/shared/scan-defaults.ts';
import { readInputs } from '../../inputs.ts';
import { type DesignDoc, type Dict, isRecord } from '../../model.ts';

export const MAX_ACTIONS = 6;
export const MAX_FLAGS = 4;

export const KINDS: readonly { value: ScanActionKind; label: string; hint: string }[] = [
  { value: 'check_in', label: 'Check in', hint: 'Let someone in or log a visit.' },
  { value: 'add', label: 'Add', hint: 'Top up a balance, or add a stamp or a point.' },
  { value: 'take', label: 'Take', hint: 'Charge a balance, or redeem a reward.' },
  { value: 'set', label: 'Set', hint: 'Change a status.' },
  { value: 'use_up', label: 'Use up', hint: 'Spend one use of the pass.' },
];
export const kindLabel = (k: ScanActionKind): string =>
  KINDS.find((x) => x.value === k)?.label ?? k;

export const REPEATS: readonly { value: ScanRepeat; label: string }[] = [
  { value: 'once', label: 'Once' },
  { value: 'daily', label: 'Daily' },
  { value: 'cooldown', label: 'Every N min' },
  { value: 'always', label: 'Always' },
];
export const ROLES: readonly { value: ScanRole; label: string }[] = [
  { value: 'door', label: 'Door' },
  { value: 'desk', label: 'Desk' },
  { value: 'manager', label: 'Manager' },
];

/** Settings that only one kind reads; a kind change drops the rest. */
const ONLY: Record<string, readonly ScanActionKind[]> = {
  amount: ['add', 'take'],
  confirmAbove: ['add', 'take'],
  value: ['set'],
  rewardLabel: ['take'],
  allowAgain: ['check_in'],
};

export type ScanBlock = Partial<ScanManifest> & Dict;

export function scanBlock(doc: DesignDoc): ScanBlock | null {
  return isRecord(doc.manifest.scan) ? (doc.manifest.scan as ScanBlock) : null;
}

/** The authored actions, or none while there is no scan block. */
export function readActions(doc: DesignDoc): ScanAction[] {
  const a = scanBlock(doc)?.actions;
  return Array.isArray(a) ? (a.filter(isRecord) as unknown as ScanAction[]) : [];
}

/** Every default applied, by action id. */
export function resolvedActions(doc: DesignDoc): Map<string, ResolvedScanAction> {
  const manifest = doc.manifest as unknown as Parameters<typeof scanOf>[0];
  return new Map(scanOf(manifest).actions.map((a) => [a.id, a]));
}

/** Inputs an action of this kind can read: numbers, scalars or dates. */
export function inputsFor(doc: DesignDoc, kind: ScanActionKind) {
  return readInputs(doc.manifest)
    .filter((s) =>
      kind === 'add' || kind === 'take'
        ? s.type === 'number'
        : kind === 'set'
          ? s.type !== 'list'
          : s.type === 'number' || s.type === 'datetime',
    )
    .map((s) => ({ value: s.name, label: s.label }));
}

function unique(base: string, taken: readonly string[], join: string): string {
  let out = base;
  for (let n = 2; taken.includes(out); n++) out = `${base}${join}${n}`;
  return out;
}

/** A new action of a kind, bound to the input a person most likely means. */
export function newAction(doc: DesignDoc, kind: ScanActionKind): ScanAction {
  const actions = readActions(doc);
  const stamps = isRecord(doc.manifest.stamps) ? doc.manifest.stamps.input : undefined;
  const stamp = typeof stamps === 'string' && (kind === 'add' || kind === 'take');
  const name = stamp ? (kind === 'add' ? 'Stamp' : 'Redeem') : kindLabel(kind);
  const input = stamp ? stamps : inputsFor(doc, kind)[0]?.value;
  const id = unique(
    kind === 'add' && stamp ? 'stamp' : kind,
    actions.map((a) => a.id),
    '_',
  );
  const label = unique(
    name,
    actions.map((a) => a.label),
    ' ',
  );
  return {
    id,
    label,
    kind,
    ...(kind !== 'check_in' && input ? { input } : {}),
    ...(kind === 'add' ? { amount: 1 } : {}),
  };
}

/** The action as a different kind: settings the new kind does not read are removed. */
export function asKind(action: ScanAction, kind: ScanActionKind): ScanAction {
  const next: Record<string, unknown> = { ...action, kind };
  for (const [key, kinds] of Object.entries(ONLY)) if (!kinds.includes(kind)) delete next[key];
  if (kind === 'add' && next.amount === undefined) next.amount = 1;
  if (kind !== 'check_in' && next.input === undefined) delete next.input;
  return next as unknown as ScanAction;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** One line staff would read: what the action does and who may do it. */
export function actionSummary(a: ResolvedScanAction): string {
  const amount =
    typeof a.amount === 'number'
      ? String(a.amount)
      : a.amount
        ? `up to ${a.amount.max}`
        : undefined;
  const when =
    a.repeat === 'cooldown'
      ? `every ${plural(a.cooldownMinutes ?? 0, 'min')}`
      : a.repeat === 'always'
        ? 'any time'
        : a.repeat;
  const role = ROLES.find((r) => r.value === a.minRole)?.label ?? a.minRole;
  return [
    amount,
    when,
    `${role}${a.minRole === 'manager' ? '' : ' and up'}`,
    a.confirm ? 'confirm' : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

export const defaultAction = (): ScanAction => ({ ...DEFAULT_SCAN_ACTION });
