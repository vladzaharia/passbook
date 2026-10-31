import type { Env, SigningIdentity } from './types.ts';
import { identityBindings } from './identity-names.ts';
import wwdrG4 from './generated/wwdr-g4.ts';

export function getSigningIdentity(env: Env, id: string): SigningIdentity {
  const names=identityBindings(id);
  const certificate=env[names.certificate],privateKey=env[names.privateKey];
  const intermediate=env[names.intermediate]??wwdrG4;
  if(typeof certificate!=='string' || typeof privateKey!=='string' || typeof intermediate!=='string') throw new Error('Signing identity is not configured');
  return {certificate,privateKey,intermediate};
}
