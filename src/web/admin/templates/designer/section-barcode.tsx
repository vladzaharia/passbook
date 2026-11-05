import { BARCODE_FORMATS } from '@/passkit/schema/constants.ts';
import { SwitchRow } from '../../../ui/index.ts';
import { useDesigner } from './context.tsx';
import { PickEdit, SourcePicker, TextEdit } from './controls.tsx';
import { BARCODE_TEXT_EMPTY, barcodeTextMissing } from './local-issues.ts';
import { type BarcodeSettings, readBarcode } from './ops-more.ts';

const label = (f: string) =>
  f.replace('PKBarcodeFormat', '').replace(/([a-z0-9])([A-Z])/g, '$1 $2');

export function BarcodeSection() {
  const { doc, edit } = useDesigner();
  const s = readBarcode(doc);
  const set = (patch: Partial<BarcodeSettings>, merge?: string) =>
    edit({ op: 'barcode', settings: { ...s, ...patch } }, merge);
  return (
    <div className="grid gap-4">
      <SwitchRow
        label="Show a barcode"
        checked={s.enabled}
        onCheckedChange={(enabled) =>
          set({ enabled, ...(enabled && !s.staticMessage ? { staticMessage: 'SAMPLE' } : {}) })
        }
      />
      {s.enabled ? (
        <>
          <PickEdit
            label="Format"
            value={s.format}
            options={BARCODE_FORMATS.map((f) => ({ value: f, label: label(f) }))}
            onPick={(format) => set({ format })}
          />
          <SourcePicker
            label="Message"
            source={s.message}
            scanCode
            staticLabel="Text in the template"
            onChange={(message) => set({ message })}
          />
          {s.message.kind === 'static' ? (
            <TextEdit
              label="Message text"
              value={s.staticMessage}
              merge="bc-message"
              error={barcodeTextMissing(doc) ? BARCODE_TEXT_EMPTY : undefined}
              op={(v) => ({ op: 'barcode', settings: { ...s, staticMessage: v } })}
            />
          ) : null}
          <SourcePicker
            label="Alt text from"
            source={s.altText}
            scanCode
            staticLabel="Text in the template"
            onChange={(altText) => set({ altText })}
          />
          {s.altText.kind === 'static' ? (
            <TextEdit
              label="Alt text"
              value={s.staticAlt}
              merge="bc-alt"
              help="Printed under the code. Leave empty for none."
              op={(v) => ({ op: 'barcode', settings: { ...s, staticAlt: v } })}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}
