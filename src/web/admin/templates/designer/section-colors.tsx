import { Callout, FormField, Input } from '../../../ui/index.ts';
import { useDesigner } from './context.tsx';
import { contrastWarnings, parseColor, toHex, toRgbText } from './contrast.ts';

const ROWS = [
  ['backgroundColor', 'Background', 'rgb(255,255,255)'],
  ['foregroundColor', 'Text', 'rgb(0,0,0)'],
  ['labelColor', 'Labels', 'rgb(90,90,90)'],
] as const;

function ColorRow({ prop, label, fallback }: { prop: string; label: string; fallback: string }) {
  const { doc, edit } = useDesigner();
  const value = typeof doc.passJson[prop] === 'string' ? (doc.passJson[prop] as string) : '';
  const rgb = parseColor(value);
  return (
    <FormField label={label} error={value && !rgb ? 'Use rgb(0,0,0) or #000000.' : undefined}>
      {(control) => (
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label={`${label} swatch`}
            className="dz-swatch"
            value={toHex(rgb ?? (parseColor(fallback) as [number, number, number]))}
            onChange={(e) => {
              const next = parseColor(e.target.value);
              if (next) edit({ op: 'pass-prop', key: prop, value: toRgbText(next) }, prop);
            }}
          />
          <Input
            {...control}
            className="font-mono"
            value={value}
            placeholder={fallback}
            onChange={(e) => edit({ op: 'pass-prop', key: prop, value: e.target.value }, prop)}
          />
        </div>
      )}
    </FormField>
  );
}

export function ColorsSection() {
  const { doc } = useDesigner();
  const warnings = contrastWarnings(doc.passJson);
  return (
    <div className="grid gap-4">
      {ROWS.map(([prop, label, fallback]) => (
        <ColorRow key={prop} prop={prop} label={label} fallback={fallback} />
      ))}
      {warnings.length > 0 ? (
        <Callout tone="warning" items={warnings.map((w) => w.message)}>
          Low contrast.
        </Callout>
      ) : null}
    </div>
  );
}
