import type { Mode } from '../../../../shared/contracts/common.ts';
import { canonicalUid, readableUid, tagRef } from '../tag-ref.ts';
import type { TagIdentity, TagSystem } from './types.ts';

export interface UidSystem extends TagSystem {
  /** The stored identity of the tag a UID names, per org and mode. */
  identify(env: object, orgId: string, mode: Mode, uid: string): Promise<TagIdentity>;
}

/** Basic: the fixed UID is the proof. */
export const UID_SYSTEM: UidSystem = {
  id: 'uid',
  assurance: 'basic',
  ready: true,
  recognise(read) {
    const uid = readableUid(read);
    return uid ? { system: 'uid', uid } : null;
  },
  identify: (env, orgId, mode, uid) => tagRef(env, orgId, mode, canonicalUid(uid)),
};
