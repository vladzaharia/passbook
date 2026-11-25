import { OPERATOR_COPY } from '../../../../shared/copy/scan-operator.ts';
import { Dialog, DialogContent } from '../../../ui/dialog.tsx';
import { keyLabel, SHORTCUTS, type ShortcutRow, viewKeys } from '../keys.ts';
import { Kbd } from './command-field.tsx';

const H = OPERATOR_COPY.help;
const GROUPS = ['find', 'record', 'lists', 'anywhere'] as const;

/** Which rows show: a key that does nothing here is left off. */
export function shortcutsFor(facts: {
  record: boolean;
  rollCall: boolean;
  views: number;
  walkIn: boolean;
}): ShortcutRow[] {
  return SHORTCUTS.filter(
    (row) =>
      !row.when ||
      (row.when === 'record' && facts.record) ||
      (row.when === 'rollCall' && facts.rollCall) ||
      (row.when === 'views' && facts.views > 1) ||
      (row.when === 'walkIn' && facts.walkIn),
  ).map((row) => (row.id === 'views' ? { ...row, keys: [viewKeys(facts.views)] } : row));
}

/** `?`: every shortcut, from the same table the keys resolve from. */
export function HelpSheet({
  open,
  onOpenChange,
  rows,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rows: readonly ShortcutRow[];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={H.title} size="md">
        <div className="op-help">
          {GROUPS.map((group) => {
            const list = rows.filter((row) => row.group === group);
            if (!list.length) return null;
            return (
              <section key={group} aria-label={OPERATOR_COPY.groups[group]}>
                <h3>{OPERATOR_COPY.groups[group]}</h3>
                <dl>
                  {list.map((row) => (
                    <div key={row.id}>
                      <dt>{row.label}</dt>
                      <dd>
                        {row.keys.map((key) => (
                          <Kbd key={key}>{keyLabel(key)}</Kbd>
                        ))}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
