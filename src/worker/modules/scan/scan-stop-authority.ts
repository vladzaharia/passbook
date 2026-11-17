import type { ScanActor } from './actor.ts';
import type { ActionPassFence } from './repo-act-pass-fence.ts';
import type { ScanEventRow } from './repo-scope.ts';

/** What a stop, held or committed answer was evaluated under: the grant checks it at commit. */
export interface StopAuthority {
  actor: ScanActor;
  event: ScanEventRow | null;
  templateId?: string;
  passFence: ActionPassFence | null;
  approvedBy?: string | null;
  approvedAuthEpoch?: number | null;
}
