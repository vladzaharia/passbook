import type { Mode } from '../../../../shared/contracts/common.ts';
import type { ScanTag, TagRead } from '../../../../shared/contracts/nfc-tags.ts';

export type TagSystemId = 'uid' | 'sun';
export type TagAssurance = ScanTag['assurance'];

/** What a system found in a read: `uid` names one physical tag; `sun` is a signed URL that a later package verifies. */
export type Recognised = { system: 'uid'; uid: string } | { system: 'sun' };

/** How a tag proves itself. A new system is one plugin here and one row in `nfc_tag_systems`. */
export interface TagSystem {
  id: TagSystemId;
  assurance: TagAssurance;
  /** Pure: null when the read is not this system's. */
  recognise(read: TagRead): Recognised | null;
  /** True once the system can verify and bind; a system without it refuses at every entry. */
  ready: boolean;
  /** The stored identity of the tag a UID names, per org and mode. */
  identify(
    env: object,
    orgId: string,
    mode: Mode,
    uid: string,
  ): Promise<{ ref: string; hint: string }>;
}
