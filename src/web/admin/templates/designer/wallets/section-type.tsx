import { Check } from 'lucide-react';
import { WALLET_CAPABILITIES } from '@/generated/wallet-capabilities.ts';
import {
  GOOGLE_TYPES,
  SAMSUNG_SUBTYPES,
  SAMSUNG_TYPES,
} from '@/passkit/template/wallets/schema.ts';
import { defaultType } from '@/passkit/wallets/google/compilers.ts';
import { wantedType } from '@/passkit/wallets/samsung/index.ts';
import { type TypeNeed, unmetNeeds } from '@/passkit/wallets/type-needs.ts';
import {
  ROLE_LABEL,
  SHORT_NAME,
  SUBTYPE_LABEL,
  typeLabel,
  WALLETS_COPY,
} from '@/shared/copy/wallets.ts';
import { FormField, OptionTile, Select, type SelectOption } from '../../../../ui/index.ts';
import { useDesigner } from '../context.tsx';
import { readInputs, scalarInputs } from '../inputs.ts';
import { STYLE_LABEL } from '../model.ts';
import { targetBlock, type WalletEnv } from './wallets-env.ts';

const C = WALLETS_COPY.type;
const AUTO = '__auto';
const ONE = '__one';
const CUSTOM = '__custom';

const TYPES = { google: GOOGLE_TYPES, samsung: SAMSUNG_TYPES } as const;
const CAPS = WALLET_CAPABILITIES as unknown as Record<
  string,
  Record<string, Record<string, string>>
>;

const needLabel = (need: TypeNeed): string =>
  need.kind === 'role'
    ? ROLE_LABEL[need.role].toLowerCase()
    : need.kind === 'image'
      ? need.slot === 'logo'
        ? 'a logo'
        : 'a main image'
      : 'a reservation number';

/** The first three roles a type has its own slot for. */
function ownSlots(target: 'google' | 'samsung', type: string): string[] {
  const table = CAPS[target]?.[type];
  if (!table) return [];
  return Object.keys(table)
    .filter((k) => k.startsWith('role.') && table[k] === 'native')
    .map((k) => ROLE_LABEL[k.slice(5) as keyof typeof ROLE_LABEL].toLowerCase())
    .filter((l) => !['title', 'subtitle', 'support', 'venue location'].includes(l))
    .slice(0, 3);
}

/** The type picker: Automatic, then every type of the wallet with what it needs. */
export function TypeSection({ env }: { env: WalletEnv }) {
  const { target, out, block, edit, readOnly } = env;
  const { view } = out;
  const set = targetBlock(block, target);
  const chosen = typeof set.type === 'string' && set.type !== 'off' ? set.type : AUTO;
  const auto = target === 'google' ? defaultType(view) : wantedType(view, undefined);
  const style = STYLE_LABEL[view.style].toLowerCase();
  const tiles = [AUTO, ...TYPES[target]];
  return (
    <div className="grid gap-4">
      <div
        className="grid grid-cols-1 gap-2 min-[22rem]:grid-cols-2"
        role="radiogroup"
        aria-label={`${SHORT_NAME[target]} type`}
      >
        {tiles.map((t) => {
          const type = t === AUTO ? auto : t;
          const unmet = unmetNeeds(target, type, view);
          const asLoyalty = target === 'samsung' && (type === 'generic' || type === 'giftcard');
          const slots = ownSlots(target, type);
          return (
            <OptionTile
              key={t}
              name={`${target}-type`}
              value={t}
              checked={chosen === t}
              disabled={readOnly}
              label={
                t === AUTO ? (
                  <span data-target={`wallets-type:auto`}>{WALLETS_COPY.automatic}</span>
                ) : (
                  typeLabel(target, t)
                )
              }
              description={
                <span className="flex flex-col gap-0.5">
                  {t === AUTO ? (
                    <span className="inline-flex items-center gap-1">
                      {chosen === AUTO ? (
                        <Check aria-hidden className="size-3.5 shrink-0 text-success" />
                      ) : null}
                      {`${typeLabel(target, auto)} for a ${style}`}
                    </span>
                  ) : unmet.length > 0 ? (
                    <span className="text-warning">
                      {C.needs.replace('{needs}', unmet.map(needLabel).join(', '))}
                    </span>
                  ) : asLoyalty ? (
                    C.asLoyalty
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      {chosen === t ? (
                        <Check aria-hidden className="size-3.5 shrink-0 text-success" />
                      ) : null}
                      {slots.length > 0
                        ? C.fits.replace('{slots}', slots.join(', '))
                        : typeLabel(target, t)}
                    </span>
                  )}
                  {t !== AUTO && chosen === AUTO && t === auto ? (
                    <span className="text-fg-subtle" data-auto-pick="">
                      {C.autoPicks}
                    </span>
                  ) : null}
                </span>
              }
              onSelect={(value) =>
                edit({ op: 'wallets-type', target, type: value === AUTO ? null : value })
              }
            />
          );
        })}
      </div>
      {target === 'google' && (chosen === 'event' || (chosen === AUTO && auto === 'event')) ? (
        <ClassKey env={env} />
      ) : null}
      {target === 'samsung' && (chosen === 'ticket' || (chosen === AUTO && auto === 'ticket')) ? (
        <SubType env={env} />
      ) : null}
    </div>
  );
}

function ClassKey({ env }: { env: WalletEnv }) {
  const { doc } = useDesigner();
  const { block, edit, readOnly } = env;
  const key = targetBlock(block, 'google').classKey;
  const inputs = scalarInputs(readInputs(doc.manifest));
  const asInput = (name: string) => `{{${name}|url}}`;
  const current =
    key === undefined ? ONE : (inputs.find((i) => key === asInput(i.name))?.name ?? CUSTOM);
  const options: SelectOption[] = [
    { value: ONE, label: C.classOne },
    ...inputs.map((i) => ({ value: i.name, label: `Input: ${i.label}` })),
    ...(current === CUSTOM ? [{ value: CUSTOM, label: 'Custom expression' }] : []),
  ];
  return (
    <FormField label={C.googleClass} help={C.classHelp}>
      {(control) => (
        <Select
          id={control.id}
          aria-describedby={control['aria-describedby']}
          options={options}
          value={current}
          disabled={readOnly}
          onValueChange={(v) => {
            if (v === CUSTOM) return;
            edit({ op: 'wallets-class-key', expr: v === ONE ? null : asInput(v) });
          }}
        />
      )}
    </FormField>
  );
}

function SubType({ env }: { env: WalletEnv }) {
  const { block, edit, readOnly } = env;
  const sub = targetBlock(block, 'samsung').subType;
  const options: SelectOption[] = [
    { value: AUTO, label: WALLETS_COPY.automatic },
    ...SAMSUNG_SUBTYPES.map((s) => ({ value: s, label: SUBTYPE_LABEL[s] })),
  ];
  return (
    <FormField label={C.ticketKind}>
      {(control) => (
        <Select
          id={control.id}
          aria-describedby={control['aria-describedby']}
          options={options}
          value={typeof sub === 'string' ? sub : AUTO}
          disabled={readOnly}
          onValueChange={(v) => edit({ op: 'wallets-subtype', subType: v === AUTO ? null : v })}
        />
      )}
    </FormField>
  );
}
