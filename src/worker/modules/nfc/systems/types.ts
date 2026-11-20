import type { ScanTag, TagRead } from '../../../../shared/contracts/nfc-tags.ts';
import type { AppEnv } from '../../../platform/env.ts';

export type TagSystemId = 'uid' | 'sun';
export type TagAssurance = ScanTag['assurance'];

/** The origins a SUN URL may name: PUBLIC_BASE_URL's host and the REDIRECT_HOSTS (issued tags keep their old host). */
export type TagEnv = Pick<AppEnv, 'PUBLIC_BASE_URL'> & { REDIRECT_HOSTS?: string };

/** What a system found in a read: `uid` names one physical tag; `sun` is a signed URL its plugin verifies. */
export type Recognised = { system: 'uid'; uid: string } | { system: 'sun' };

/** How a tag proves itself. A new system is one plugin here and one row in `nfc_tag_systems`. */
export interface TagSystem {
  id: TagSystemId;
  assurance: TagAssurance;
  /** Pure: null when the read is not this system's. */
  recognise(read: TagRead, env: TagEnv): Recognised | null;
  /** True once the system can verify and bind; a system without it refuses at every entry. */
  ready: boolean;
}

/** A tag's stored identity in one org and mode. Only a system that proved the tag makes one. */
export interface TagIdentity {
  ref: string;
  hint: string;
}
