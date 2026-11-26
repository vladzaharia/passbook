import { useState } from 'react';
import type { WalletRole, WalletRoleSource } from '@/passkit/template/wallets/schema.ts';
import { SHORT_NAME, typeLabel, WALLETS_COPY } from '@/shared/copy/wallets.ts';
import { useInsertHighlight } from '../../../../lib/motion.ts';
import { Button } from '../../../../ui/index.ts';
import { morph } from './morph.ts';
import { RoleRow } from './role-row.tsx';
import { type RoleRow as Row, roleRows } from './roles-model.ts';
import { requiredOf, type WalletEnv } from './wallets-env.ts';

const C = WALLETS_COPY.roles;

function Rows({
  title,
  rows,
  env,
  fresh,
}: {
  title: string;
  rows: readonly Row[];
  env: WalletEnv;
  fresh: ReadonlySet<string>;
}) {
  if (rows.length === 0) return null;
  return (
    <section aria-label={title} className="grid gap-1">
      <h4 className="text-xs font-medium uppercase tracking-wide text-fg-muted">{title}</h4>
      <ul className="divide-y divide-border">
        {rows.map((r) => (
          <RoleRow
            key={r.role}
            row={r}
            env={env}
            fields={env.out.view.fields}
            fresh={fresh.has(r.role)}
          />
        ))}
      </ul>
    </section>
  );
}

/** The role table: own slots, written as text, then everything not set. */
export function RolesSection({ env }: { env: WalletEnv }) {
  const { target, out, block, edit } = env;
  const roles = (block.roles ?? undefined) as
    | Partial<Record<WalletRole, WalletRoleSource>>
    | undefined;
  const { rows, proposals } = roleRows(
    out.view,
    target,
    out.compiled.type,
    roles,
    requiredOf(block),
  );
  const [open, setOpen] = useState(false);
  const fresh = useInsertHighlight(rows.filter((r) => r.authored !== undefined).map((r) => r.role));
  const own = rows.filter((r) => r.group === 'own');
  const text = rows.filter((r) => r.group === 'text');
  const none = rows.filter((r) => r.group === 'none');
  const acceptAll = () =>
    morph(() =>
      edit({
        op: 'wallets-roles',
        sources: Object.fromEntries(proposals.map((p) => [p.role, p.source])),
      }),
    );
  return (
    <div className="grid gap-4">
      {proposals.length > 0 && !env.readOnly ? (
        <Button
          variant="outline"
          size="sm"
          className="justify-self-start"
          onClick={acceptAll}
          data-accept=""
        >
          {C.accept.replace('{n}', String(proposals.length))}
        </Button>
      ) : null}
      <Rows
        title={C.own
          .replace('{wallet}', SHORT_NAME[target])
          .replace('{type}', typeLabel(target, out.compiled.type).toLowerCase())}
        rows={own}
        env={env}
        fresh={fresh}
      />
      <Rows
        title={C.text.replace('{wallet}', SHORT_NAME[target])}
        rows={text}
        env={env}
        fresh={fresh}
      />
      {none.length > 0 ? (
        <div className="grid gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="justify-self-start"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {C.notSet.replace('{n}', String(none.length))}
          </Button>
          {open ? (
            <Rows
              title={C.notSet.replace('{n}', String(none.length))}
              rows={none}
              env={env}
              fresh={fresh}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
