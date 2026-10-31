import { httpJsonSource } from './http-json.ts';
import { object, text, assert } from '../util.ts';
import type { UpdateSource } from './types.ts';

/** Example contract, deliberately explicit. Replace this mapping or register another adapter for your API. */
const membershipAPI=httpJsonSource({
  id:'membership-api', intervalSeconds:900,
  request({reference,env}) {
    if(!env.MEMBERSHIP_API_BASE_URL || !env.MEMBERSHIP_API_TOKEN) throw new Error('Membership API is not configured');
    const base=new URL(env.MEMBERSHIP_API_BASE_URL);
    assert(!base.username && !base.password && !base.search && !base.hash,'Invalid membership API base URL');
    const url=new URL(`members/${encodeURIComponent(reference)}`,base.href.replace(/\/?$/,'/'));
    return new Request(url,{headers:{Authorization:`Bearer ${env.MEMBERSHIP_API_TOKEN}`,Accept:'application/json'}});
  },
  map(data) {
    const member=object(data);
    assert(typeof member.active==='boolean','Upstream active must be a boolean');
    return {
      memberName:text(member.name,'upstream name',80),
      membership:text(member.membership,'upstream membership',80),
      status:member.active?'Active':'Suspended',
      voided:!member.active,
      ...(member.keyTag!==undefined?{memberId:text(member.keyTag,'upstream key tag',64)}:{})
    };
  }
});
export const sources: Readonly<Record<string,UpdateSource>>=Object.freeze({[membershipAPI.id]:membershipAPI});
export function getSource(id: string): UpdateSource {
  assert(Object.hasOwn(sources,id),'Unknown update source');
  return sources[id];
}
