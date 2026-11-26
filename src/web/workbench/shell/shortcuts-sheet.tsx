import { SHORTCUTS, WB_SHELL_COPY } from '@/shared/copy/workbench-shell.ts';
import { Dialog, DialogContent } from '../../ui/dialog.tsx';
import { SwitchRow } from '../../ui/switch-row.tsx';
import { setSingleKeys, useSingleKeys } from './prefs.ts';

/** A key or a chord as caps: "g h" is two caps, "j / k" keeps its slash. */
function Keys({ text }: { text: string }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {text.split(' ').map((part, i) =>
        part === '/' || part === 'or' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed sequence of caps
          <span key={i} className="text-xs text-fg-muted">
            {part}
          </span>
        ) : (
          <kbd
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed sequence of caps
            key={i}
            className="inline-grid min-w-6 place-items-center rounded-sm border border-border-strong bg-surface-sunken px-1.5 font-mono text-xs text-fg-strong"
          >
            {part}
          </kbd>
        ),
      )}
    </span>
  );
}

/**
 * Every key in one sheet (design §5.4), with the collision note and the single-key switch
 * (WCAG 2.1.4). The account menu's "Keyboard shortcuts" and `?` / ⌘/ open it.
 */
export function ShortcutsSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const singleKeys = useSingleKeys();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={SHORTCUTS.title} size="lg">
        <div className="flex flex-col gap-5 px-5 py-4">
          <SwitchRow
            label={WB_SHELL_COPY.singleKeys}
            help={WB_SHELL_COPY.singleKeysHelp}
            checked={singleKeys}
            onCheckedChange={setSingleKeys}
          />
          <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
            {SHORTCUTS.groups.map((group) => (
              <section key={group.heading} aria-label={group.heading}>
                <h3 className="mb-1.5 text-sm font-semibold text-fg-strong">{group.heading}</h3>
                <dl className="flex flex-col">
                  {group.rows.map(([keys, action]) => (
                    <div
                      key={keys}
                      className="flex min-h-8 items-center justify-between gap-3 border-b border-border py-1 last:border-b-0"
                    >
                      <dt className="text-sm text-fg">{action}</dt>
                      <dd>
                        <Keys text={keys} />
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
          <p className="max-w-[65ch] text-xs text-fg-muted">{SHORTCUTS.collisions}</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
