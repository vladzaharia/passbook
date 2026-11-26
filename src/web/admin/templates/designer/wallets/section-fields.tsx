import { Pencil } from 'lucide-react';
import { walletName } from '@/shared/copy/previews.ts';
import { GROUP_NAME, ROLE_LABEL, WALLETS_COPY } from '@/shared/copy/wallets.ts';
import { Badge, Button, Switch } from '../../../../ui/index.ts';
import { useDesigner } from '../context.tsx';
import type { GroupId } from '../model.ts';
import { type Destination, fieldRows } from './field-map.ts';
import { targetBlock, type WalletEnv } from './wallets-env.ts';

const C = WALLETS_COPY.fields;

function Pill({ d, target }: { d: Destination; target: 'google' | 'samsung' }) {
  switch (d.kind) {
    case 'own':
      return <Badge>{C.ownSlot.replace('{role}', ROLE_LABEL[d.role])}</Badge>;
    case 'text':
      return <Badge>{target === 'samsung' ? C.notice : C.text}</Badge>;
    case 'notShown':
      return <Badge tone="warning">{C.notShown}</Badge>;
    case 'leftOut':
      return <Badge>{C.leftOut}</Badge>;
  }
}

/** Where each Apple field lands on the wallet, front to back, with a switch to leave it out. */
export function FieldsSection({ env }: { env: WalletEnv }) {
  const { focusTarget } = useDesigner();
  const { target, out, block, edit, readOnly } = env;
  const omit = (targetBlock(block, target).omit ?? []) as string[];
  const rows = fieldRows(out.view, out.compiled, target, omit);
  const wallet = walletName(target);
  if (rows.length === 0) return <p className="text-sm text-fg-muted">{C.none}</p>;
  const groups = [...new Set(rows.map((r) => r.group))];
  return (
    <div className="grid gap-4">
      {groups.map((g) => (
        <section key={g} aria-label={`${GROUP_NAME[g]} fields`} className="grid gap-1">
          <h4 className="text-xs font-medium uppercase tracking-wide text-fg-muted">
            {GROUP_NAME[g]}
          </h4>
          <ul className="divide-y divide-border">
            {rows
              .filter((r) => r.group === g)
              .map((r) => (
                <li
                  key={r.path}
                  data-row-id={`wf-${r.path}`}
                  data-target={`wallets-fields:${r.path}`}
                  tabIndex={-1}
                  className="flex flex-col gap-1 py-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-sm text-fg-strong">{r.label}</span>
                    <span className="flex shrink-0 items-center gap-2">
                      <Pill d={r.destination} target={target} />
                      <Switch
                        checked={r.destination.kind !== 'leftOut'}
                        disabled={readOnly}
                        aria-label={C.show.replace('{label}', r.label).replace('{wallet}', wallet)}
                        onCheckedChange={(on) =>
                          edit({
                            op: 'wallets-omit',
                            target,
                            entry: on ? (r.omitEntry ?? r.path) : r.path,
                            on: !on,
                          })
                        }
                      />
                    </span>
                  </div>
                  <div className="flex min-w-0 items-center justify-between gap-2 text-xs text-fg-muted">
                    <span className="[overflow-wrap:anywhere]">
                      {r.destination.kind === 'notShown' ? r.destination.reason : ' '}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      iconStart={<Pencil aria-hidden />}
                      onClick={() => focusTarget({ section: `${g}Fields` as GroupId, key: r.key })}
                    >
                      {C.edit}
                    </Button>
                  </div>
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
