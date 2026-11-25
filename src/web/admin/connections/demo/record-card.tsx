import { type CSSProperties, useState } from 'react';
import { hueOf, initialsOf } from '../../../ui/avatar.tsx';
import { KeyValue } from '../../../ui/index.ts';
import { type DemoDataset, showValue } from './datasets.ts';

/** Eight hues, so the avatars of one dataset read as a set; never the data colours. */
const HUES = [20, 70, 140, 175, 215, 255, 300, 340] as const;

function Avatar({ name }: { name: string }) {
  const hue = HUES[hueOf(name) % HUES.length] ?? 215;
  return (
    <span
      aria-hidden
      data-initials={initialsOf(name)}
      style={{ background: `oklch(0.5 0.11 ${hue})` } as CSSProperties}
      className="inline-flex size-10 shrink-0 select-none items-center justify-center rounded-full text-sm font-semibold text-white after:content-[attr(data-initials)]"
    />
  );
}

/** The sample record in the wizard aside: who it is, six fields, the rest on request. */
export function RecordCard({
  dataset,
  sample,
}: {
  dataset: DemoDataset;
  sample: readonly { pointer: string; preview: string }[];
}) {
  const [all, setAll] = useState(false);
  const by = new Map(sample.map((f) => [f.pointer, f.preview]));
  const name = dataset.name
    .map((p) => by.get(p))
    .filter(Boolean)
    .join(' ');
  const shown = dataset.keys.length
    ? dataset.keys.map((f) => ({
        label: f.label,
        value: showValue(by.get(f.pointer) ?? '') || null,
      }))
    : sample.slice(0, 6).map((f) => ({ label: f.pointer, value: showValue(f.preview) }));
  return (
    <div className="flex min-w-0 flex-col gap-3 border-t border-border pt-5">
      <p className="text-xs font-medium text-fg-muted">Sample record</p>
      <div className="flex min-w-0 items-center gap-3">
        <Avatar name={name} />
        <p className="min-w-0 truncate text-sm font-medium text-fg-strong">{name}</p>
      </div>
      <KeyValue items={shown} />
      <button
        type="button"
        aria-expanded={all}
        onClick={() => setAll(!all)}
        className="min-h-6 self-start text-xs text-accent-fg underline-offset-2 hover:underline pointer-coarse:min-h-11"
      >
        {all ? 'Fewer fields' : `All ${sample.length} fields`}
      </button>
      {all ? (
        <KeyValue
          items={sample.map((f) => ({ label: f.pointer, value: showValue(f.preview), mono: true }))}
        />
      ) : null}
    </div>
  );
}
