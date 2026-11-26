import { Lock, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import type { ViewField } from '@/passkit/wallets/types.ts';
import { ROLE_LABEL, WALLETS_COPY } from '@/shared/copy/wallets.ts';
import { cn } from '../../../../lib/cn.ts';
import { useChangeCount } from '../../../../lib/motion.ts';
import { Button, Input } from '../../../../ui/index.ts';
import { morph } from './morph.ts';
import { RoleSourceMenu } from './role-source-menu.tsx';
import type { RoleRow as Row } from './roles-model.ts';
import type { WalletEnv } from './wallets-env.ts';

const C = WALLETS_COPY.roles;

/** One role: its name, where it reads from now, what it shows, and the suggestion if there is one. */
export function RoleRow({
  row,
  env,
  fields,
  fresh,
}: {
  row: Row;
  env: WalletEnv;
  fields: readonly ViewField[];
  fresh: boolean;
}) {
  const { edit, readOnly } = env;
  const [typing, setTyping] = useState<string | null>(null);
  const lockChanges = useChangeCount(row.required);
  const p = row.proposal;
  const use = () =>
    p && morph(() => edit({ op: 'wallets-role', role: row.role, source: p.source }));
  const expr =
    row.authored && typeof row.authored === 'object' && 'value' in row.authored
      ? String(typeof row.authored.value === 'string' ? row.authored.value : '')
      : '';
  return (
    <li
      data-new={fresh || undefined}
      data-row-id={`role-${row.role}`}
      className="flex flex-col gap-1 py-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-fg-strong">
          <span className="truncate">{row.label}</span>
          {row.required ? (
            <span
              key={lockChanges}
              className={cn('text-fg-muted', lockChanges > 0 && 'wm-lock')}
              title="Required on every wallet"
            >
              <Lock aria-hidden className="size-3.5" />
              <span className="sr-only">Required on every wallet</span>
            </span>
          ) : null}
          {row.problem ? (
            <span className="text-warning">
              <TriangleAlert aria-hidden className="size-3.5" />
            </span>
          ) : null}
        </span>
        <span className="flex items-center gap-1.5">
          {p && !readOnly ? (
            <Button
              variant="outline"
              size="sm"
              aria-label={`Use ${p.label} for ${row.label}`}
              data-use={row.role}
              onClick={use}
            >
              {C.use}
            </Button>
          ) : null}
          <RoleSourceMenu
            row={row}
            fields={fields}
            disabled={readOnly}
            morph={p ? undefined : `role-src-${row.role}`}
            onPick={(source) => edit({ op: 'wallets-role', role: row.role, source })}
            onValue={() => setTyping(expr)}
            onRequire={(on) => edit({ op: 'wallets-required', id: `role.${row.role}`, on })}
          />
        </span>
      </div>
      {typing !== null ? (
        <Input
          autoFocus
          aria-label={`${row.label} ${C.valueLabel.toLowerCase()}`}
          placeholder={C.valuePlaceholder}
          value={typing}
          onChange={(e) => setTyping(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setTyping(null);
            if (e.key === 'Enter' && typing.trim()) {
              edit({ op: 'wallets-role', role: row.role, source: { value: typing.trim() } });
              setTyping(null);
            }
          }}
          onBlur={() => setTyping(null)}
        />
      ) : null}
      <p className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-fg-muted">
        {p ? (
          <>
            <span
              className="rounded-full border border-dashed border-accent px-2 text-accent-fg"
              style={{ viewTransitionName: `role-src-${row.role}` }}
            >
              {C.suggested.replace('{field}', p.label)}
            </span>
            <span className="[overflow-wrap:anywhere]">{p.text}</span>
          </>
        ) : (
          <>
            {row.provenance ? <span>{row.provenance}</span> : null}
            <span className="[overflow-wrap:anywhere]" data-flash={fresh || undefined}>
              {row.value}
            </span>
          </>
        )}
      </p>
      {row.problem ? <p className="text-xs text-danger">{row.problem}</p> : null}
    </li>
  );
}

export const roleLabel = (r: Row['role']): string => ROLE_LABEL[r];
