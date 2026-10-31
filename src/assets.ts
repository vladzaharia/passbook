import type { Env, PassTemplate } from './types.ts';
export async function loadAsset(env: Pick<Env,'ASSETS'>, path: string): Promise<Uint8Array> {
  const response=await env.ASSETS.fetch(new Request(`https://assets.invalid${path}`));
  if(!response.ok) throw new Error('Template artwork is missing');
  return new Uint8Array(await response.arrayBuffer());
}
export async function loadAssets(env: Pick<Env,'ASSETS'>, template: PassTemplate): Promise<Record<string,Uint8Array>> {
  return Object.fromEntries(await Promise.all(Object.entries(template.assets).map(async([name,path])=>[name,await loadAsset(env,path)])));
}
