import { useMemo } from 'react';
import { chainLevelOf } from '@/shared/channels.ts';
import { useTemplateChannels } from '../../channels/api.ts';
import type { WalletName } from './roles-model.ts';

export interface WalletChannels {
  /** The wallets with a tile: those the org, plan and PassBook allow. Null while unknown. */
  listed: readonly WalletName[] | null;
  /** The template turns this wallet off: its tile is hatched and stays open. */
  templateOff: ReadonlySet<WalletName>;
}

const BOTH: readonly WalletName[] = ['google', 'samsung'];
const NONE: ReadonlySet<WalletName> = new Set();

/**
 * Which wallets the tab lists, by the same rule as the stage's channel tabs: a wallet only the
 * template or the pass turns off stays (hatched); one the organization, the plan or PassBook
 * withholds has no tile. Without an organization (a platform template) both are listed.
 */
export function useWalletChannels(templateId: string | undefined, orgId: string | undefined) {
  const channels = useTemplateChannels(templateId ?? '', orgId ?? '', Boolean(templateId && orgId));
  return useMemo<WalletChannels>(() => {
    if (!templateId || !orgId) return { listed: BOTH, templateOff: NONE };
    const all = channels.data?.effective;
    if (!all) return { listed: channels.isError ? BOTH : null, templateOff: NONE };
    const listed: WalletName[] = [];
    const off = new Set<WalletName>();
    for (const wallet of BOTH) {
      const s = all[wallet];
      if (s.on !== false) listed.push(wallet);
      else if (['template', 'pass'].includes(chainLevelOf(s.source, s.reason))) {
        listed.push(wallet);
        off.add(wallet);
      }
    }
    return { listed, templateOff: off };
  }, [channels.data, channels.isError, templateId, orgId]);
}
