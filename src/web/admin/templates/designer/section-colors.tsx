import { useState } from 'react';
import { TEMPLATE_BRAND_COPY } from '@/shared/copy/template-brand.ts';
import { Button, Callout, FormField, Input } from '../../../ui/index.ts';
import { SourceTag } from '../../brand/source-tag.tsx';
import { useDesigner } from './context.tsx';
import { contrastWarnings, parseColor, type Rgb, toHex, toRgbText } from './contrast.ts';
import { ownParts } from './ops-brand.ts';
import { useOrgBrand } from './org-brand.ts';

const COPY = TEMPLATE_BRAND_COPY.designer;

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

/** The organization's colours, which every pass of the template uses until it overrides them. */
function OrgColors({ colors }: { colors: NonNullable<ReturnType<typeof useOrgBrand>['colors']> }) {
  const { edit, readOnly } = useDesigner();
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface-raised p-3">
      <div className="flex min-w-0 flex-col gap-2">
        <SourceTag source="org" label={COPY.fromOrg} />
        <div className="flex items-center gap-2" role="img" aria-label={COPY.colorsNote}>
          {[colors.background, colors.foreground, colors.label].map((c, i) =>
            c ? (
              <span
                // The three colours always come in the same order, so the position is the key.
                key={['background', 'text', 'labels'][i]}
                className="size-7 rounded-full border border-border-strong"
                style={{ background: c }}
              />
            ) : null,
          )}
        </div>
        <p className="text-xs text-fg-muted">{COPY.colorsNote}</p>
      </div>
      <Button
        variant="outline"
        size="sm"
        disabled={readOnly}
        onClick={() => edit({ op: 'brand', part: 'colors', own: true })}
      >
        {COPY.override}
      </Button>
    </div>
  );
}

export function ColorsSection() {
  const { doc, edit, orgId, readOnly } = useDesigner();
  const org = useOrgBrand(orgId);
  const own = ownParts(doc).includes('colors');
  const warnings = contrastWarnings(doc.passJson);
  if (org.colors && !own) return <OrgColors colors={org.colors} />;
  return (
    <div className="grid gap-4">
      {org.colors ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SourceTag source="template" label={COPY.own} />
          <Button
            variant="ghost"
            size="sm"
            disabled={readOnly}
            onClick={() => edit({ op: 'brand', part: 'colors', own: false })}
          >
            {COPY.useOrg}
          </Button>
        </div>
      ) : null}
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
