import { Check, ChevronDown } from 'lucide-react';
import type { WalletRoleSource } from '@/passkit/template/wallets/schema.ts';
import type { ViewField, WalletRole } from '@/passkit/wallets/types.ts';
import { GROUP_NAME, ROLE_LABEL, WALLETS_COPY } from '@/shared/copy/wallets.ts';
import { ACTION_ICON as I } from '../../../../lib/action-icons.ts';
import { cn } from '../../../../lib/cn.ts';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../../../ui/index.ts';
import type { RoleRow } from './roles-model.ts';

const C = WALLETS_COPY.roles;

/** What the source button says: `Auto Balance`, `Tier`, `Value {{tier}}`, `Empty`, `Not set`. */
export function sourceText(row: RoleRow, fields: readonly ViewField[]): string {
  const { authored, resolved } = row;
  if (authored === false) return C.empty;
  if (authored && 'field' in authored)
    return fields.find((f) => f.key === authored.field)?.label ?? authored.field;
  if (authored && 'value' in authored)
    return `Value ${typeof authored.value === 'string' ? authored.value : JSON.stringify(authored.value.const)}`;
  return resolved ? `${C.auto} ${resolved.label ?? valueText(resolved)}`.trim() : C.notSetValue;
}

const valueText = (r: NonNullable<RoleRow['resolved']>): string =>
  r.kind === 'text' ? r.text : r.kind;

const current = (row: RoleRow): string =>
  row.authored === undefined
    ? 'auto'
    : row.authored === false
      ? 'empty'
      : 'field' in row.authored
        ? `field:${row.authored.field}`
        : 'value';

/** The row's source button and its menu: Automatic, one field, a value, empty, required. */
export function RoleSourceMenu({
  row,
  fields,
  disabled,
  morph,
  onPick,
  onValue,
  onRequire,
}: {
  row: RoleRow;
  fields: readonly ViewField[];
  disabled: boolean;
  /** The View Transition name the suggestion chip hands over to this button. */
  morph: string | undefined;
  onPick: (source: WalletRoleSource | null) => void;
  onValue: () => void;
  onRequire: (on: boolean) => void;
}) {
  const label = ROLE_LABEL[row.role as WalletRole];
  const groups = [...new Set(fields.map((f) => f.group))];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label={`${label} source: ${sourceText(row, fields)}`}
        data-target={`wallets-roles:${row.role}`}
        style={morph ? { viewTransitionName: morph } : undefined}
        className={cn(
          'inline-flex h-8 max-w-48 items-center gap-1 rounded-md border border-border-strong bg-surface-raised px-2 text-xs text-fg wl-colors pointer-coarse:h-11',
          'hover:border-fg-muted focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-60',
        )}
      >
        <span className="truncate">{sourceText(row, fields)}</span>
        <ChevronDown aria-hidden className="size-3.5 shrink-0 text-fg-muted" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 min-w-56 overflow-y-auto">
        <DropdownMenuRadioGroup
          value={current(row)}
          onValueChange={(v) => {
            if (v === 'auto') onPick(null);
            else if (v === 'empty') onPick(false);
            else if (v.startsWith('field:')) onPick({ field: v.slice(6) });
          }}
        >
          <DropdownMenuRadioItem value="auto">
            {C.automaticMenu}
            {row.resolved && row.authored !== undefined ? `: ${row.value}` : ''}
          </DropdownMenuRadioItem>
          {groups.map((g) => (
            <div key={g}>
              <DropdownMenuLabel>{GROUP_NAME[g]}</DropdownMenuLabel>
              {fields
                .filter((f) => f.group === g)
                .map((f) => (
                  <DropdownMenuRadioItem key={f.path} value={`field:${f.key}`}>
                    {GROUP_NAME[g]} · {f.label ?? f.key}
                  </DropdownMenuRadioItem>
                ))}
            </div>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuRadioItem value="empty">{C.leaveEmpty}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuItem onSelect={onValue}>
          <I.edit aria-hidden />
          {C.valueItem}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onRequire(!row.required)}>
          <Check aria-hidden className={cn('size-4', !row.required && 'invisible')} />
          {C.requiredEvery}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
