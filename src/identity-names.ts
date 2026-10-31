export function identityBindings(id: string) {
  if(!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error('Invalid signing identity name');
  const prefix='SIGNER_'+id.replaceAll('-','_').toUpperCase();
  return {certificate:prefix+'_CERTIFICATE',privateKey:prefix+'_PRIVATE_KEY',intermediate:prefix+'_INTERMEDIATE'};
}
