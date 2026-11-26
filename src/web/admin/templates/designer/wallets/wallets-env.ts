import type { WalletOut } from '../../../../channel-previews/wallet-kit.ts';
import type { Op } from '../apply.ts';
import type { Dict } from '../model.ts';
import type { WalletName } from './roles-model.ts';

/** What every section of the Wallets inspector reads for the focused wallet. */
export interface WalletEnv {
  target: WalletName;
  /** Compiled body, report and view of this wallet, from the same render as the draft. */
  out: WalletOut;
  /** `manifest.wallets`, or an empty block. */
  block: Dict;
  edit: (op: Op, merge?: string) => void;
  /** The base URL of the draft's files, for art thumbnails. */
  assetBase: string;
  readOnly: boolean;
}

export const targetBlock = (block: Dict, target: WalletName): Dict =>
  typeof block[target] === 'object' && block[target] !== null && !Array.isArray(block[target])
    ? (block[target] as Dict)
    : {};

export const requiredOf = (block: Dict): string[] =>
  Array.isArray(block.required) ? (block.required as string[]) : [];
