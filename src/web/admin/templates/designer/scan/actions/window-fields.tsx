import type { ValidationIssue } from '@/passkit/types.ts';
import { useDesigner } from '../../context.tsx';
import { PickEdit } from '../../controls.tsx';
import { readInputs } from '../../inputs.ts';
import { IssueList, NumEdit } from './fields.tsx';
import { scanBlock } from './model.ts';
import type { WindowPatch } from './ops.ts';

const NONE = '__none';

/** When a pass is good: a start and an end read from date-time inputs, with grace either side. */
export function WindowFields({ issues }: { issues: readonly ValidationIssue[] }) {
  const { doc, edit } = useDesigner();
  const w = scanBlock(doc)?.window ?? {};
  const dates = readInputs(doc.manifest)
    .filter((s) => s.type === 'datetime')
    .map((s) => ({ value: s.name, label: s.label }));
  const set = (patch: WindowPatch, merge?: string) => edit({ op: 'scan-window', patch }, merge);
  const pick = (key: 'from' | 'until', label: string) => (
    <PickEdit
      label={label}
      value={w[key] ?? NONE}
      options={[{ value: NONE, label: 'Any time' }, ...dates]}
      onPick={(v) => set({ [key]: v === NONE ? null : v })}
    />
  );
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        {pick('from', 'Valid from')}
        {pick('until', 'Valid until')}
      </div>
      {dates.length === 0 ? (
        <p className="text-xs text-fg-muted">Add a date and time input to set a window.</p>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <NumEdit
          label="Early entry"
          unit="min"
          min={0}
          step={1}
          value={w.earlyMinutes}
          merge="win-early"
          op={(v) => ({ op: 'scan-window', patch: { earlyMinutes: v } })}
        />
        <NumEdit
          label="Late entry"
          unit="min"
          min={0}
          step={1}
          value={w.lateMinutes}
          merge="win-late"
          op={(v) => ({ op: 'scan-window', patch: { lateMinutes: v } })}
        />
      </div>
      <IssueList issues={issues} label="Window issues" />
    </div>
  );
}
