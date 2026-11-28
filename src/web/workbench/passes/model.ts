import type { PassDetailDto, PassSummaryDto } from '@/shared/contracts/passes.ts';
import { WB_PASSES } from '@/shared/copy/workbench-passes.ts';
import type { WalletMood } from '../../ui/art/wallet.tsx';
import type { StatusTone } from '../bench/status-chip.tsx';
import type { Prefill } from '../host/prefill.ts';

export const TABS = [
  { id: 'events', label: WB_PASSES.tabs.events },
  { id: 'devices', label: WB_PASSES.tabs.devices },
  { id: 'versions', label: WB_PASSES.tabs.versions },
  { id: 'calls', label: WB_PASSES.tabs.calls },
] as const;
export type PassTab = (typeof TABS)[number]['id'];
export const isTab = (v: string | null): v is PassTab => TABS.some((t) => t.id === v);

type Named = Pick<PassSummaryDto, 'title'>;
type Stated = Pick<PassSummaryDto, 'status' | 'removedAt'>;

export const titleOf = (p: Named): string => p.title ?? WB_PASSES.untitled;

/** What the pass is to a holder: removed from Wallet reads Removed, though it is stored voided. */
export const stateOf = (p: Stated): keyof typeof WB_PASSES.status =>
  p.removedAt !== null ? 'removed' : p.status;

export const toneOf = (p: Stated): StatusTone => (p.status === 'active' ? 'success' : 'danger');

/** The buddy's mood is the selected record's: sorry for a voided pass, glad for what this tab just did. */
export function moodOf(p: Stated, cheering: boolean): WalletMood {
  if (p.status !== 'active') return 'sad';
  return cheering ? 'happy' : 'flat';
}

/**
 * Open in Console (design §4.3): the operation and what it needs, by `sessionStorage` nonce. A void
 * arrives prefilled and the Console asks before it runs.
 */
export function consolePrefills(
  pass: Pick<PassDetailDto, 'id' | 'personalization'>,
): Record<'update' | 'void' | 'simulate', Prefill> {
  const path = { id: pass.id };
  return {
    update: { op: 'passes.patchPassesById', path, body: { input: pass.personalization } },
    void: { op: 'passes.postPassesByIdVoid', path },
    simulate: { op: 'passes.postPassesByIdSimulate', path, body: { event: 'installed' } },
  };
}
