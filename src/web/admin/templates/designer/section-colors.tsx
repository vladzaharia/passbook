import { useState } from 'react';
import { Callout, FormField, Input } from '../../../ui/index.ts';
import { useDesigner } from './context.tsx';
import { contrastWarnings, parseColor, type Rgb, toHex, toRgbText } from './contrast.ts';

const ROWS = [
  ['backgroundColor', 'Background', '#ffffff'],
  ['foregroundColor', 'Text', '#000000'],
  ['labelColor', 'Labels', '#5a5a5a'],
] as const;

function ColorRow({ prop, label, fallback }: { prop: string; label: string; fallback: string }) {
  const { doc, edit } = useDesigner();
  const value = typeof doc.passJson[prop] === 'string' ? (doc.passJson[prop] as string) : '';
  const rgb = parseColor(value);
  // Shown as hex; what is being typed stays as typed until the field loses focus.
  const [typing, setTyping] = useState<string | null>(null);
  const shown = typing ?? (rgb ? toHex(rgb) : value);
  return (
    <FormField label={label} error={value && !rgb ? 'Use #000000 or rgb(0,0,0).' : undefined}>
      {(control) => (
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label={`${label} swatch`}
            className="dz-swatch"
            value={toHex(rgb ?? (parseColor(fallback) as Rgb))}
            onChange={(e) => {
              const next = parseColor(e.target.value);
              if (next) {
                setTyping(null);
                edit({ op: 'pass-prop', key: prop, value: toRgbText(next) }, prop);
              }
            }}
          />
          <Input
            {...control}
            className="font-mono"
            value={shown}
            placeholder={fallback}
            onBlur={() => setTyping(null)}
            onChange={(e) => {
              const text = e.target.value;
              setTyping(text);
              const next = parseColor(text);
              edit({ op: 'pass-prop', key: prop, value: next ? toRgbText(next) : text }, prop);
            }}
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
