import type { BrandPartName } from '@/passkit/template/brand.ts';
import { renameIn } from '@/passkit/template/merge/renames.ts';
import type { Json, PassStyle, TemplateManifest } from '@/passkit/types.ts';
import { type AccessOp, applyAccessOp } from './access/ops.ts';
import type { Source } from './bindings.ts';
import { applyCounterOp, type CounterOp } from './counters.ts';
import { setSlotImage } from './images.ts';
import type { InputSpec } from './inputs.ts';
import type { DesignDoc, DraftAsset, GroupId, Target } from './model.ts';
import { setBrandPart } from './ops-brand.ts';
import {
  addInput,
  type BarcodeSettings,
  type ListKey,
  moveInput,
  removeInput,
  setBarcode,
  setDisplay,
  setList,
  setMeta,
  updateInput,
} from './ops-more.ts';
import { type PaperPatch, setPaper } from './ops-paper.ts';
import {
  addField,
  addGenericLayout,
  moveField,
  nudgeField,
  removeField,
  renameField,
  setDictProp,
  setFieldLink,
  setFieldSource,
  setFieldValue,
  setPassProp,
  setPoster,
  setStyle,
  setTarget,
  updateField,
} from './ops-pass.ts';
import { type ActionsOp, applyActionsOp } from './scan/actions/ops.ts';
import { setLookupInput } from './scan/lookup.ts';
import { applyScanOp, type ScanOp } from './scan/ops-scan.ts';
import {
  type ArtSlot,
  addStamps,
  renameStampsInput,
  setArt,
  setGoal,
  setStampsInput,
  setStampsProp,
} from './stamps.ts';

/** Every edit the designer makes. Plain data, so the history can replay and tests can read it. */
export type Op =
  | { op: 'meta'; name?: string; description?: string }
  | { op: 'style'; style: PassStyle }
  | { op: 'poster'; on: boolean }
  | { op: 'target'; target: Target }
  | { op: 'poster-repair' }
  | { op: 'pass-prop'; key: string; value: unknown }
  | { op: 'dict-prop'; key: string; value: unknown }
  | { op: 'field-add'; group: GroupId; key?: string }
  | { op: 'field-remove'; key: string }
  | { op: 'field-move'; key: string; group: GroupId; index: number }
  | { op: 'field-nudge'; key: string; delta: -1 | 1 }
  | { op: 'field-set'; key: string; patch: Record<string, unknown> }
  | { op: 'field-value'; key: string; value: string }
  | { op: 'field-key'; key: string; to: string }
  | { op: 'field-source'; key: string; source: Source; optional: boolean }
  | { op: 'field-link'; key: string; on: boolean; optional: boolean }
  | { op: 'input-add'; spec: InputSpec }
  | { op: 'input-set'; name: string; patch: Partial<InputSpec> }
  | { op: 'input-remove'; name: string }
  | { op: 'input-move'; name: string; to: number }
  | { op: 'display'; part: 'title' | 'subtitle'; expr: string }
  | { op: 'barcode'; settings: BarcodeSettings }
  | { op: 'scan-lookup'; input: string }
  | { op: 'list'; key: ListKey; items: Record<string, unknown>[] }
  | { op: 'paper'; patch: PaperPatch }
  | { op: 'image'; slot: string; asset: DraftAsset | null }
  | { op: 'brand'; part: BrandPartName; own: boolean }
  | { op: 'stamps-add'; art: Partial<Record<ArtSlot, DraftAsset>> }
  | { op: 'stamps-goal'; goal: number }
  | { op: 'stamps-set'; patch: { tilt?: boolean; keepReady?: boolean; maximum?: number } }
  | { op: 'stamps-art'; slot: ArtSlot; asset: DraftAsset | null }
  | { op: 'stamps-input'; input: string }
  | CounterOp
  | ScanOp
  | ActionsOp
  | AccessOp;

/** Rewrites every reference left to a renamed input, with the merge engine's own walk. */
function renameReferences(doc: DesignDoc, from: string, to: string): DesignDoc {
  const renamed = renameIn(
    {
      passJson: doc.passJson as Json,
      manifest: doc.manifest as unknown as TemplateManifest,
      files: {},
    },
    { kind: 'input', from, to },
  );
  return {
    ...doc,
    passJson: renamed.passJson as DesignDoc['passJson'],
    manifest: renamed.manifest as unknown as DesignDoc['manifest'],
  };
}

export function applyOp(doc: DesignDoc, o: Op): DesignDoc {
  switch (o.op) {
    case 'meta':
      return setMeta(doc, o);
    case 'style':
      return setStyle(doc, o.style);
    case 'poster':
      return setPoster(doc, o.on);
    case 'target':
      return setTarget(doc, o.target);
    case 'poster-repair':
      return addGenericLayout(doc);
    case 'pass-prop':
      return setPassProp(doc, o.key, o.value);
    case 'dict-prop':
      return setDictProp(doc, o.key, o.value);
    case 'field-add':
      return addField(doc, o.group, o.key).doc;
    case 'field-remove':
      return removeField(doc, o.key);
    case 'field-move':
      return moveField(doc, o.key, o.group, o.index);
    case 'field-nudge':
      return nudgeField(doc, o.key, o.delta);
    case 'field-set':
      return updateField(doc, o.key, o.patch);
    case 'field-value':
      return setFieldValue(doc, o.key, o.value);
    case 'field-key':
      return renameField(doc, o.key, o.to);
    case 'field-source':
      return setFieldSource(doc, o.key, o.source, o.optional);
    case 'field-link':
      return setFieldLink(doc, o.key, o.on, o.optional);
    case 'input-add':
      return addInput(doc, o.spec);
    case 'input-set': {
      const next = updateInput(doc, o.name, o.patch);
      return o.patch.name && o.patch.name !== o.name && next !== doc
        ? renameReferences(renameStampsInput(next, o.name, o.patch.name), o.name, o.patch.name)
        : next;
    }
    case 'input-remove':
      return removeInput(doc, o.name);
    case 'input-move':
      return moveInput(doc, o.name, o.to);
    case 'display':
      return setDisplay(doc, o.part, o.expr);
    case 'barcode':
      return setBarcode(doc, o.settings);
    case 'scan-lookup':
      return setLookupInput(doc, o.input);
    case 'list':
      return setList(doc, o.key, o.items);
    case 'paper':
      return setPaper(doc, o.patch);
    case 'image':
      return setSlotImage(doc, o.slot, o.asset);
    case 'brand':
      return setBrandPart(doc, o.part, o.own);
    case 'scan-display':
      return applyScanOp(doc, o);
    case 'stamps-add':
      return addStamps(doc, o.art);
    case 'stamps-goal':
      return setGoal(doc, o.goal);
    case 'stamps-set':
      return setStampsProp(doc, o.patch);
    case 'stamps-art':
      return setArt(doc, o.slot, o.asset);
    case 'stamps-input':
      return setStampsInput(doc, o.input);
    case 'counter-add':
    case 'counter-set':
    case 'counter-remove':
    case 'counter-scan':
      return applyCounterOp(doc, o);
    case 'scan-enable':
    case 'scan-action-add':
    case 'scan-action-set':
    case 'scan-action-kind':
    case 'scan-action-remove':
    case 'scan-action-move':
    case 'scan-window':
    case 'scan-flags':
      return applyActionsOp(doc, o);
    case 'access-enable':
    case 'access-disable':
    case 'access-plan-add':
    case 'access-plan-set':
    case 'access-plan-kind':
    case 'access-plan-remove':
    case 'access-plan-move':
    case 'access-rules':
    case 'access-suspend':
      return applyAccessOp(doc, o);
  }
}
