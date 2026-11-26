/** Where each Apple field lands on one wallet, from the compiler's own items and the view's roles. */
import { WALLET_CAPABILITIES } from '@/generated/wallet-capabilities.ts';
import type {
  CompileResult,
  ViewField,
  ViewGroup,
  WalletPassView,
  WalletRole,
} from '@/passkit/wallets/types.ts';
import type { WalletName } from './roles-model.ts';

export type Destination =
  | { kind: 'own'; role: WalletRole }
  | { kind: 'text' }
  | { kind: 'notShown'; reason: string }
  | { kind: 'leftOut' };

export interface FieldRow {
  path: string;
  key: string;
  group: ViewGroup;
  label: string;
  destination: Destination;
  /** The `omit` entry that leaves it out, when it is left out. */
  omitEntry: string | undefined;
}

const CAPS = WALLET_CAPABILITIES as unknown as Record<
  string,
  Record<string, Record<string, string>>
>;

/** The entry of `omit` that names this field: its path or its bare key. */
export const omitEntryFor = (omit: readonly string[], field: Pick<ViewField, 'path' | 'key'>) =>
  omit.find((e) => e === field.path || e === field.key);

/** One row per Apple field, front to back. */
export function fieldRows(
  view: WalletPassView,
  compiled: CompileResult,
  target: WalletName,
  omit: readonly string[],
): FieldRow[] {
  return view.fields.map((f): FieldRow => {
    const entry = omitEntryFor(omit, f);
    const owner = (Object.keys(view.roles) as WalletRole[]).find(
      (r) =>
        view.roles[r]?.fields.includes(f.path) &&
        CAPS[target]?.[compiled.type]?.[`role.${r}`] === 'native',
    );
    const hit = compiled.items.filter((i) => i.path === f.path);
    const lost = hit.find((i) => i.support === 'omitted' || i.support === 'unsupported');
    let destination: Destination = { kind: 'text' };
    if (entry !== undefined) destination = { kind: 'leftOut' };
    else if (owner) destination = { kind: 'own', role: owner };
    else if (lost) destination = { kind: 'notShown', reason: lost.message };
    return {
      path: f.path,
      key: f.key,
      group: f.group,
      label: f.label ?? f.key,
      destination,
      omitEntry: entry,
    };
  });
}
