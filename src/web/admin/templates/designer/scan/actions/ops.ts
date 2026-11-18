import type { ScanAction, ScanActionKind, ScanManifest } from '@/passkit/types.ts';
import { type DesignDoc, isRecord } from '../../model.ts';
import { asKind, defaultAction, MAX_ACTIONS, newAction, readActions, scanBlock } from './model.ts';

/** `null` in a patch removes the setting. */
export type ActionPatch = { [K in keyof ScanAction]?: ScanAction[K] | null };
export type WindowPatch = {
  [K in keyof NonNullable<ScanManifest['window']>]?: string | number | null;
};

export type ActionsOp =
  | { op: 'scan-enable' }
  | { op: 'scan-action-add'; kind: ScanActionKind }
  | { op: 'scan-action-set'; id: string; patch: ActionPatch }
  | { op: 'scan-action-kind'; id: string; kind: ScanActionKind }
  | { op: 'scan-action-remove'; id: string }
  | { op: 'scan-action-move'; id: string; to: number }
  | { op: 'scan-window'; patch: WindowPatch }
  | { op: 'scan-flags'; flags: NonNullable<ScanManifest['flags']> };

function withScan(doc: DesignDoc, patch: Record<string, unknown>): DesignDoc {
  const scan = scanBlock(doc) ?? {};
  const next: Record<string, unknown> = { ...scan, ...patch };
  for (const [k, v] of Object.entries(next)) if (v === undefined) delete next[k];
  return { ...doc, manifest: { ...doc.manifest, scan: next } };
}

function merged<T extends object>(base: T, patch: Record<string, unknown>): T {
  const next = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) delete next[k];
    else next[k] = v;
  }
  return next as T;
}

export function applyActionsOp(doc: DesignDoc, o: ActionsOp): DesignDoc {
  const actions = readActions(doc);
  const at = (id: string) => actions.findIndex((a) => a.id === id);
  const put = (list: ScanAction[]) => withScan(doc, { actions: list });
  switch (o.op) {
    case 'scan-enable':
      return scanBlock(doc) ? doc : withScan(doc, { actions: [defaultAction()] });
    case 'scan-action-add':
      return actions.length >= MAX_ACTIONS ? doc : put([...actions, newAction(doc, o.kind)]);
    case 'scan-action-set': {
      const i = at(o.id);
      const old = actions[i];
      if (!old) return doc;
      return put(actions.map((a, j) => (j === i ? merged(old, o.patch) : a)));
    }
    case 'scan-action-kind': {
      const old = actions[at(o.id)];
      if (!old || old.kind === o.kind) return doc;
      return put(actions.map((a) => (a.id === o.id ? asKind(a, o.kind) : a)));
    }
    case 'scan-action-remove':
      return actions.length <= 1 || at(o.id) < 0 ? doc : put(actions.filter((a) => a.id !== o.id));
    case 'scan-action-move': {
      const from = at(o.id);
      if (from < 0 || o.to < 0 || o.to >= actions.length) return doc;
      const next = [...actions];
      const [item] = next.splice(from, 1);
      if (item) next.splice(o.to, 0, item);
      return put(next);
    }
    case 'scan-window': {
      const scan = scanBlock(doc);
      const old = isRecord(scan?.window) ? scan.window : {};
      const window = merged(old, o.patch);
      return withScan(doc, { window: Object.keys(window).length ? window : undefined });
    }
    case 'scan-flags':
      return withScan(doc, { flags: o.flags.length ? o.flags : undefined });
  }
}
