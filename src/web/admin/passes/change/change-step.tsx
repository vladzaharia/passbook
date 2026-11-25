import { Ban, Layers, Pencil } from 'lucide-react';
import type { CSSProperties } from 'react';
import { OptionTile } from '../../../ui/index.ts';
import { CHANGE_COPY as C } from './copy.ts';
import { FieldRows } from './field-rows.tsx';
import type { ChangeKind } from './model.ts';
import type { ChangeWizard } from './use-change-wizard.ts';

const KINDS = [
  { kind: 'fields', icon: Pencil },
  { kind: 'design', icon: Layers },
  { kind: 'void', icon: Ban },
] as const satisfies readonly { kind: ChangeKind; icon: unknown }[];

/** C1: what to do to the passes: set fields, move to the latest design, or void. */
export function ChangeStep({
  w,
  which,
  showErrors,
}: {
  w: ChangeWizard;
  which: string;
  showErrors: boolean;
}) {
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm font-medium text-fg-strong">{which}</p>
      <div
        role="radiogroup"
        aria-label="Kind of change"
        className="wl-deal grid gap-3 @[40rem]:grid-cols-3"
      >
        {KINDS.map(({ kind, icon }, i) => (
          <div key={kind} style={{ '--i': i } as CSSProperties} className="flex">
            <OptionTile
              name="change-kind"
              value={kind}
              icon={icon}
              label={C.kinds[kind]}
              description={C.kindHelp[kind]}
              checked={w.kind === kind}
              className="w-full"
              onSelect={() => w.chooseKind(kind)}
            />
          </div>
        ))}
      </div>
      {w.kind === 'fields' ? (
        <FieldRows fields={w.fields} rows={w.rows} onChange={w.setRows} showErrors={showErrors} />
      ) : null}
    </div>
  );
}
