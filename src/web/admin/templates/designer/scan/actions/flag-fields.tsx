import { Plus, Trash2 } from 'lucide-react';
import type { ScanManifest, ValidationIssue } from '@/passkit/types.ts';
import { Button, IconButton, Input, SwitchRow } from '../../../../../ui/index.ts';
import { useDesigner } from '../../context.tsx';
import { PickEdit } from '../../controls.tsx';
import { readInputs, scalarInputs } from '../../inputs.ts';
import { IssueList, ListEdit } from './fields.tsx';
import { MAX_FLAGS, scanBlock } from './model.ts';

type Flag = NonNullable<ScanManifest['flags']>[number];

/** Notes that show on the scan result when an input matches; a stop note blocks the scan. */
export function FlagFields({ issues }: { issues: readonly ValidationIssue[] }) {
  const { doc, edit, readOnly } = useDesigner();
  const flags = scanBlock(doc)?.flags ?? [];
  const inputs = scalarInputs(readInputs(doc.manifest));
  const write = (next: Flag[]) => edit({ op: 'scan-flags', flags: next });
  const patch = (i: number, p: Partial<Flag>) =>
    write(flags.map((f, j) => (j === i ? { ...f, ...p } : f)));
  return (
    <div className="grid gap-3">
      <ul aria-label="Notes" className="grid gap-3">
        {flags.map((f, i) => {
          const spec = inputs.find((s) => s.name === f.input);
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: flags have no id
            <li key={i} className="dz-editor grid gap-3 rounded-md border border-border p-3">
              <div className="flex items-end gap-2">
                <PickEdit
                  className="min-w-0 flex-1"
                  label={`Note ${i + 1} input`}
                  value={f.input}
                  options={inputs.map((s) => ({ value: s.name, label: s.label }))}
                  onPick={(input) => patch(i, { input, equals: undefined })}
                />
                <IconButton
                  label={`Remove note ${i + 1}`}
                  icon={<Trash2 aria-hidden />}
                  variant="ghost"
                  size="sm"
                  disabled={readOnly}
                  onClick={() => write(flags.filter((_x, j) => j !== i))}
                />
              </div>
              <div className="grid gap-1.5">
                <label className="text-sm font-medium text-fg-strong" htmlFor={`flag-${i}`}>
                  Note {i + 1} text
                </label>
                <Input
                  id={`flag-${i}`}
                  value={f.label}
                  readOnly={readOnly}
                  placeholder="Allergy"
                  onChange={(e) => patch(i, { label: e.target.value })}
                />
              </div>
              <ListEdit
                key={f.input}
                label={`Note ${i + 1} shows when`}
                help={
                  spec?.type === 'choice'
                    ? `Values: ${(spec.options ?? []).map((o) => o.value).join(', ')}. Empty: any value.`
                    : 'Separate with commas. Empty: any value.'
                }
                value={f.equals ?? []}
                onCommit={(equals) => patch(i, { equals: equals.length ? equals : undefined })}
              />
              <SwitchRow
                label="Stop the scan"
                help="Staff must clear it before letting anyone in."
                checked={f.stop === true}
                disabled={readOnly}
                onCheckedChange={(stop) => patch(i, { stop: stop ? true : undefined })}
              />
            </li>
          );
        })}
      </ul>
      <Button
        variant="outline"
        size="sm"
        className="justify-self-start"
        iconStart={<Plus aria-hidden />}
        disabled={readOnly || flags.length >= MAX_FLAGS || inputs.length === 0}
        onClick={() => write([...flags, { input: inputs[0]?.name ?? '', label: 'Note' }])}
      >
        Add note
      </Button>
      {inputs.length === 0 ? <p className="text-xs text-fg-muted">Add an input first.</p> : null}
      <IssueList issues={issues} label="Note issues" />
    </div>
  );
}
