import type { PassStyle } from '@/passkit/types.ts';
import type { Source } from './bindings.ts';
import { setSlotImage } from './images.ts';
import type { InputSpec } from './inputs.ts';
import type { DesignDoc, DraftAsset, GroupId } from './model.ts';
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
import {
  addField,
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
  updateField,
} from './ops-pass.ts';

/** Every edit the designer makes. Plain data, so the history can replay and tests can read it. */
export type Op =
  | { op: 'meta'; name?: string; description?: string }
  | { op: 'style'; style: PassStyle }
  | { op: 'poster'; on: boolean }
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
  | { op: 'list'; key: ListKey; items: Record<string, unknown>[] }
  | { op: 'image'; slot: string; asset: DraftAsset | null };

export function applyOp(doc: DesignDoc, o: Op): DesignDoc {
  switch (o.op) {
    case 'meta':
      return setMeta(doc, o);
    case 'style':
      return setStyle(doc, o.style);
    case 'poster':
      return setPoster(doc, o.on);
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
    case 'input-set':
      return updateInput(doc, o.name, o.patch);
    case 'input-remove':
      return removeInput(doc, o.name);
    case 'input-move':
      return moveInput(doc, o.name, o.to);
    case 'display':
      return setDisplay(doc, o.part, o.expr);
    case 'barcode':
      return setBarcode(doc, o.settings);
    case 'list':
      return setList(doc, o.key, o.items);
    case 'image':
      return setSlotImage(doc, o.slot, o.asset);
  }
}
